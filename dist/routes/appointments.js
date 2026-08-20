import { Router } from "express";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { newId } from "../lib/ids.js";
import { sendEmail } from "../lib/email.js";
import { getSiteContactSettings } from "../lib/siteContactSettings.js";
import { buildIcsInvite } from "../lib/ics.js";
import { createGoogleCalendarEvent, googleCalendarConfigured } from "../lib/googleCalendar.js";
import { hashOtp, sendDualChannelOtp } from "../lib/otp.js";
import { getOtpProviderSettings } from "../lib/otpProviderSettings.js";
import { sendMsg91TransactionalSms } from "../lib/msg91.js";
const appointmentsRouter = Router();
let schemaReady = false;
async function ensureAppointmentsSchema() {
  if (schemaReady) return;
  const pool = getPool();
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS expert_appointments (
      id VARCHAR(36) PRIMARY KEY,
      full_name VARCHAR(200) NOT NULL,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      topic VARCHAR(120) NOT NULL,
      preferred_date DATE NOT NULL,
      preferred_time VARCHAR(16) NOT NULL,
      duration_minutes INT NOT NULL DEFAULT 30,
      notes TEXT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'scheduled',
      google_event_id VARCHAR(255) NULL,
      google_event_link TEXT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS appointment_otps (
      id VARCHAR(36) PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      otp_hash VARCHAR(128) NOT NULL,
      channel VARCHAR(32) NOT NULL,
      purpose VARCHAR(64) NOT NULL DEFAULT 'appointment_booking',
      expires_at TIMESTAMPTZ NOT NULL,
      verified_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS appointment_otp_verifications (
      id VARCHAR(36) PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  schemaReady = true;
}
const BookSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number"),
  topic: z.string().trim().min(2).max(120),
  preferredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  preferredTime: z.string().regex(/^\d{2}:\d{2}$/),
  notes: z.string().trim().max(1e3).optional().nullable(),
  consentAccepted: z.literal(true),
  otpVerificationId: z.string().trim().min(10)
});
const OtpRequestSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number"),
  topic: z.string().trim().min(2).max(120),
  preferredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  preferredTime: z.string().regex(/^\d{2}:\d{2}$/),
  notes: z.string().trim().max(1e3).optional().nullable(),
  consentAccepted: z.literal(true)
});
const OtpVerifySchema = z.object({
  email: z.string().trim().email().max(255),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number"),
  mobileOtp: z.string().trim().length(6).optional(),
  emailOtp: z.string().trim().length(6).optional()
});
function salesTeamEmail(contact) {
  return process.env.SALES_TEAM_EMAIL || process.env.APPOINTMENT_SALES_EMAIL || contact?.emails?.[0] || contact?.email || "support@rfincare.com";
}
function combineDateTimeIst(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const utcMs = Date.UTC(y, m - 1, d, hh - 5, mm - 30, 0);
  return new Date(utcMs);
}
function formatDisplay(date) {
  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}
async function verifyOtpAndCreateVerification(pool, { email, phone, mobileOtp, emailOtp }) {
  const settings = await getOtpProviderSettings();
  const requireMobileOtp = settings.requireMobileOtp !== false;
  const requireEmailOtp = settings.requireEmailOtp !== false;
  if (requireMobileOtp && !mobileOtp) {
    return { ok: false, error: "Mobile OTP is required." };
  }
  if (requireEmailOtp && !emailOtp) {
    return { ok: false, error: "Email OTP is required." };
  }
  if (requireMobileOtp) {
    const [[smsRow]] = await pool.execute(
      `SELECT id FROM appointment_otps
       WHERE email = :email AND phone = :phone AND channel = 'sms' AND purpose = 'appointment_booking'
         AND otp_hash = :hash AND verified_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      { email, phone, hash: hashOtp(mobileOtp) }
    );
    if (!smsRow?.id) return { ok: false, error: "Invalid or expired mobile OTP." };
    await pool.execute(`UPDATE appointment_otps SET verified_at = NOW() WHERE id = :id`, { id: smsRow.id });
  }
  if (requireEmailOtp) {
    const [[emailRow]] = await pool.execute(
      `SELECT id FROM appointment_otps
       WHERE email = :email AND phone = :phone AND channel = 'email' AND purpose = 'appointment_booking'
         AND otp_hash = :hash AND verified_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      { email, phone, hash: hashOtp(emailOtp) }
    );
    if (!emailRow?.id) return { ok: false, error: "Invalid or expired email OTP." };
    await pool.execute(`UPDATE appointment_otps SET verified_at = NOW() WHERE id = :id`, {
      id: emailRow.id
    });
  }
  const verificationId = newId();
  const verificationExpiresAt = new Date(Date.now() + 15 * 60 * 1e3);
  await pool.execute(
    `INSERT INTO appointment_otp_verifications (id, email, phone, expires_at)
     VALUES (:id, :email, :phone, :expires_at)`,
    {
      id: verificationId,
      email,
      phone,
      expires_at: verificationExpiresAt
    }
  );
  return { ok: true, verificationId, expiresInSeconds: 900 };
}
appointmentsRouter.get("/slots", async (_req, res, next) => {
  try {
    const slots = [];
    const now = /* @__PURE__ */ new Date();
    const hours = ["09:00", "10:00", "11:00", "12:00", "14:00", "15:00", "16:00", "17:00"];
    for (let dayOffset = 0; dayOffset < 14; dayOffset += 1) {
      const day = new Date(now);
      day.setDate(day.getDate() + dayOffset);
      if (day.getDay() === 0) continue;
      const y = day.getFullYear();
      const m = String(day.getMonth() + 1).padStart(2, "0");
      const d = String(day.getDate()).padStart(2, "0");
      const date = `${y}-${m}-${d}`;
      for (const time of hours) {
        const starts = combineDateTimeIst(date, time);
        if (starts.getTime() < Date.now() + 60 * 60 * 1e3) continue;
        slots.push({ date, time, label: `${formatDisplay(starts)}` });
      }
    }
    res.json({ slots: slots.slice(0, 56) });
  } catch (err) {
    next(err);
  }
});
appointmentsRouter.post("/otp/request", async (req, res, next) => {
  try {
    await ensureAppointmentsSchema();
    const input = OtpRequestSchema.parse(req.body);
    const startsAt = combineDateTimeIst(input.preferredDate, input.preferredTime);
    if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() < Date.now()) {
      return res.status(400).json({ error: "Please choose a future date and time slot." });
    }
    const settings = await getOtpProviderSettings();
    const otpResult = await sendDualChannelOtp({
      phone: input.phone,
      email: input.email,
      settings
    });
    const pool = getPool();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1e3);
    if (otpResult.requireMobileOtp && otpResult.mobileOtp) {
      await pool.execute(
        `INSERT INTO appointment_otps (id, email, phone, otp_hash, channel, purpose, expires_at)
         VALUES (:id, :email, :phone, :hash, 'sms', 'appointment_booking', :expires_at)`,
        {
          id: newId(),
          email: input.email,
          phone: input.phone,
          hash: hashOtp(otpResult.mobileOtp),
          expires_at: expiresAt
        }
      );
    }
    if (otpResult.requireEmailOtp && otpResult.emailOtp) {
      await pool.execute(
        `INSERT INTO appointment_otps (id, email, phone, otp_hash, channel, purpose, expires_at)
         VALUES (:id, :email, :phone, :hash, 'email', 'appointment_booking', :expires_at)`,
        {
          id: newId(),
          email: input.email,
          phone: input.phone,
          hash: hashOtp(otpResult.emailOtp),
          expires_at: expiresAt
        }
      );
    }
    res.json({
      success: true,
      message: "OTP sent successfully.",
      expiresInSeconds: 600,
      requireMobileOtp: otpResult.requireMobileOtp,
      requireEmailOtp: otpResult.requireEmailOtp,
      warnings: Array.isArray(otpResult.warnings) && otpResult.warnings.length ? otpResult.warnings : void 0,
      ...process.env.LOG_OTP === "true" ? {
        devMobileOtp: otpResult.mobileOtp || void 0,
        devEmailOtp: otpResult.emailOtp || void 0
      } : {}
    });
  } catch (err) {
    next(err);
  }
});
appointmentsRouter.post("/otp/verify", async (req, res, next) => {
  try {
    await ensureAppointmentsSchema();
    const input = OtpVerifySchema.parse(req.body);
    const pool = getPool();
    const verify = await verifyOtpAndCreateVerification(pool, input);
    if (!verify.ok) {
      return res.status(401).json({ error: verify.error || "Invalid or expired OTP." });
    }
    res.json({
      success: true,
      otpVerificationId: verify.verificationId,
      expiresInSeconds: verify.expiresInSeconds
    });
  } catch (err) {
    next(err);
  }
});
appointmentsRouter.post("/", async (req, res, next) => {
  try {
    await ensureAppointmentsSchema();
    const input = BookSchema.parse(req.body);
    const pool = getPool();
    const [[verification]] = await pool.execute(
      `SELECT id FROM appointment_otp_verifications
       WHERE id = :id AND email = :email AND phone = :phone
         AND used_at IS NULL AND expires_at > NOW()
       LIMIT 1`,
      {
        id: input.otpVerificationId,
        email: input.email,
        phone: input.phone
      }
    );
    if (!verification?.id) {
      return res.status(401).json({ error: "OTP verification is required before booking." });
    }
    const durationMinutes = 30;
    const startsAt = combineDateTimeIst(input.preferredDate, input.preferredTime);
    if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() < Date.now()) {
      return res.status(400).json({ error: "Please choose a future date and time slot." });
    }
    const endsAt = new Date(startsAt.getTime() + durationMinutes * 60 * 1e3);
    const contact = await getSiteContactSettings();
    const salesEmail = salesTeamEmail(contact);
    const id = newId();
    const topicLabel = input.topic;
    const summary = `Rfincare Expert Call — ${input.fullName}`;
    const description = [
      `Customer: ${input.fullName}`,
      `Email: ${input.email}`,
      `Phone: +91-${input.phone}`,
      `Topic: ${topicLabel}`,
      input.notes ? `Notes: ${input.notes}` : null,
      "",
      "Booked via Rfincare Talk to Expert."
    ].filter(Boolean).join("\n");
    let google = { created: false };
    try {
      google = await createGoogleCalendarEvent({
        summary,
        description,
        startIso: startsAt.toISOString(),
        endIso: endsAt.toISOString(),
        attendeeEmails: [input.email, salesEmail],
        location: "Rfincare — Phone / Video consultation"
      });
    } catch (err) {
      console.warn("[appointments] Google Calendar sync failed:", err?.message || err);
      google = { created: false, reason: err?.message || "calendar_error" };
    }
    await pool.execute(
      `INSERT INTO expert_appointments (
         id, full_name, email, phone, topic, preferred_date, preferred_time,
         duration_minutes, notes, status, google_event_id, google_event_link,
         starts_at, ends_at
       ) VALUES (
         :id, :full_name, :email, :phone, :topic, :preferred_date, :preferred_time,
         :duration_minutes, :notes, 'scheduled', :google_event_id, :google_event_link,
         :starts_at, :ends_at
       )`,
      {
        id,
        full_name: input.fullName,
        email: input.email,
        phone: input.phone,
        topic: topicLabel,
        preferred_date: input.preferredDate,
        preferred_time: input.preferredTime,
        duration_minutes: durationMinutes,
        notes: input.notes || null,
        google_event_id: google.eventId || null,
        google_event_link: google.htmlLink || null,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString()
      }
    );
    const whenLabel = formatDisplay(startsAt);
    const ics = buildIcsInvite({
      uid: `${id}@rfincare.com`,
      summary,
      description,
      location: "Rfincare — Phone / Video consultation",
      start: startsAt,
      end: endsAt,
      organizerEmail: salesEmail,
      attendeeEmails: [input.email, salesEmail]
    });
    const icsAttachment = {
      filename: "rfincare-appointment.ics",
      content: Buffer.from(ics, "utf8"),
      contentType: "text/calendar; charset=utf-8; method=REQUEST"
    };
    const customerSubject = `Appointment confirmed — ${whenLabel}`;
    const customerText = [
      `Hi ${input.fullName},`,
      "",
      "Your consultation with an Rfincare financial expert is confirmed.",
      "",
      `When: ${whenLabel} (IST)`,
      `Topic: ${topicLabel}`,
      `Duration: ${durationMinutes} minutes`,
      google.htmlLink ? `Calendar: ${google.htmlLink}` : null,
      "",
      "Our sales team will call you on +91-" + input.phone + " at the scheduled time.",
      "",
      "Need to reschedule? Reply to this email or contact support@rfincare.com.",
      "",
      "— Team Rfincare"
    ].filter(Boolean).join("\n");
    const salesSubject = `New expert appointment — ${input.fullName} · ${whenLabel}`;
    const salesText = [
      "A customer booked a Talk to Expert appointment.",
      "",
      `Name: ${input.fullName}`,
      `Email: ${input.email}`,
      `Phone: +91-${input.phone}`,
      `When: ${whenLabel} (IST)`,
      `Topic: ${topicLabel}`,
      input.notes ? `Notes: ${input.notes}` : null,
      google.htmlLink ? `Google Calendar: ${google.htmlLink}` : null,
      google.created ? null : "Note: Google Calendar sync was skipped or failed — use the ICS attachment.",
      "",
      `Appointment ID: ${id}`
    ].filter(Boolean).join("\n");
    const [customerMail, salesMail] = await Promise.all([
      sendEmail({
        to: input.email,
        subject: customerSubject,
        text: customerText,
        html: `<pre style="font-family:sans-serif;white-space:pre-wrap">${customerText}</pre>`,
        attachments: [icsAttachment]
      }),
      sendEmail({
        to: salesEmail,
        subject: salesSubject,
        text: salesText,
        html: `<pre style="font-family:sans-serif;white-space:pre-wrap">${salesText}</pre>`,
        attachments: [icsAttachment]
      })
    ]);
    let sms = { sent: false, reason: "sms_not_sent" };
    try {
      const smsText = [
        `Rfincare: appointment confirmed.`,
        `When: ${whenLabel}`,
        `Topic: ${topicLabel}`,
        `Duration: ${durationMinutes} minutes`
      ].join("\n");
      sms = await sendMsg91TransactionalSms({
        phone: input.phone,
        message: smsText
      });
    } catch (smsErr) {
      sms = {
        sent: false,
        reason: smsErr?.message || "sms_error",
        warning: smsErr?.message || "SMS could not be sent."
      };
    }
    const emailWarnings = [
      customerMail?.sent === false ? customerMail?.warning || customerMail?.reason : null,
      salesMail?.sent === false ? salesMail?.warning || salesMail?.reason : null
    ].filter(Boolean);
    await pool.execute(
      `UPDATE appointment_otp_verifications SET used_at = NOW() WHERE id = :id`,
      { id: verification.id }
    );
    res.status(201).json({
      id,
      status: "scheduled",
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      whenLabel,
      googleCalendar: {
        configured: googleCalendarConfigured(),
        synced: Boolean(google.created),
        eventLink: google.htmlLink || null,
        reason: google.reason || null
      },
      emails: {
        customer: customerMail,
        sales: salesMail,
        salesEmail
      },
      sms,
      message: emailWarnings.length || sms?.sent === false ? "Appointment booked, but some notifications may not have been delivered. Please check the warnings." : "Appointment booked. Confirmation emails sent to you and our sales team.",
      notificationWarnings: {
        emailWarnings,
        smsWarning: sms?.sent === false ? sms?.warning || sms?.reason : null
      }
    });
  } catch (err) {
    if (err?.name === "ZodError") {
      return res.status(400).json({ error: err.errors?.[0]?.message || "Invalid booking details" });
    }
    next(err);
  }
});
export {
  appointmentsRouter
};
