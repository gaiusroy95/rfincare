import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { newId } from '../lib/ids.js';
import { sendEmail, publicEmailDeliveryMessage } from '../lib/email.js';
import { getSiteContactSettings } from '../lib/siteContactSettings.js';
import { buildIcsInvite } from '../lib/ics.js';
import { createGoogleCalendarEvent, googleCalendarConfigured, resolveAppointmentVideoLink } from '../lib/googleCalendar.js';
import { hashOtp, sendDualChannelOtp, sendPublicOtpFailure } from '../lib/otp.js';
import {
  assertOtpVerifyAllowed,
  canExposeDevOtp,
  clearOtpVerifyFailures,
  failedOtpMessage,
  otpTargetKeys,
} from '../lib/otpSecurity.js';
import { getOtpProviderSettings } from '../lib/otpProviderSettings.js';
import { sendMsg91TransactionalSms, isMsg91Configured } from '../lib/msg91.js';

export const appointmentsRouter = Router();

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
  // Meet / video join link (added after initial schema).
  try {
    const [[col]] = await pool.execute(
      `SELECT 1 AS ok FROM information_schema.columns
       WHERE table_name = 'expert_appointments' AND column_name = 'meet_link' LIMIT 1`,
    );
    if (!col) {
      await pool.execute(`ALTER TABLE expert_appointments ADD COLUMN meet_link TEXT NULL`);
    }
  } catch (err) {
    console.warn('[appointments:schema] meet_link column:', err?.message || err);
  }
  schemaReady = true;
}

const BookSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'),
  topic: z.string().trim().min(2).max(120),
  preferredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  preferredTime: z.string().regex(/^\d{2}:\d{2}$/),
  notes: z.string().trim().max(1000).optional().nullable(),
  consentAccepted: z.literal(true),
  otpVerificationId: z.string().trim().min(10),
});

const OtpRequestSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'),
  topic: z.string().trim().min(2).max(120),
  preferredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  preferredTime: z.string().regex(/^\d{2}:\d{2}$/),
  notes: z.string().trim().max(1000).optional().nullable(),
  consentAccepted: z.literal(true),
});

const OtpVerifySchema = z.object({
  email: z.string().trim().email().max(255),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'),
  mobileOtp: z.string().trim().length(6).optional(),
  emailOtp: z.string().trim().length(6).optional(),
});

const SUPPORT_EMAIL = 'support@rfincare.com';

function salesTeamEmail(contact) {
  return (
    process.env.SALES_TEAM_EMAIL
    || process.env.APPOINTMENT_SALES_EMAIL
    || contact?.emails?.[0]
    || contact?.email
    || SUPPORT_EMAIL
  );
}

function buildAppointmentEmailHtml({ title, lines, meetUrl, whenLabel }) {
  const rows = lines
    .filter(Boolean)
    .map((line) => `<p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:14px;color:#111">${escapeHtml(line)}</p>`)
    .join('');
  const meetBlock = meetUrl
    ? `<p style="margin:16px 0"><a href="${escapeHtml(meetUrl)}" style="display:inline-block;background:#0b6e4f;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-family:Arial,sans-serif;font-weight:600">Join video call</a></p>
       <p style="margin:0 0 12px;font-family:Arial,sans-serif;font-size:13px;color:#444">Or open: <a href="${escapeHtml(meetUrl)}">${escapeHtml(meetUrl)}</a></p>`
    : '';
  return `
    <div style="max-width:560px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">
      <h2 style="font-family:Arial,sans-serif;color:#0b6e4f;margin:0 0 8px">${escapeHtml(title)}</h2>
      <p style="font-family:Arial,sans-serif;font-size:15px;color:#111;margin:0 0 16px"><strong>When:</strong> ${escapeHtml(whenLabel)} (IST)</p>
      ${meetBlock}
      ${rows}
      <p style="margin:20px 0 0;font-family:Arial,sans-serif;font-size:12px;color:#666">— Team Rfincare</p>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function combineDateTimeIst(dateStr, timeStr) {
  // Interpret slot as Asia/Kolkata local time
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  // Build as UTC offset +05:30
  const utcMs = Date.UTC(y, m - 1, d, hh - 5, mm - 30, 0);
  return new Date(utcMs);
}

function formatDisplay(date) {
  return date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Soft-fail email helper with one plain retry (no attachments) if first attempt fails. */
async function sendAppointmentEmail(opts) {
  let result = await sendEmail(opts);
  if (result?.sent) return result;
  if (opts.attachments?.length) {
    console.warn('[appointments:email] retrying without attachments', {
      to: opts.to,
      reason: result?.reason || result?.warningInternal,
    });
    result = await sendEmail({ ...opts, attachments: undefined });
  }
  if (!result?.sent && result?.warningInternal) {
    console.error('[appointments:email]', result.warningInternal, { to: opts.to });
  }
  return result;
}

/**
 * Notify sales inbox + lead_level ≥ 2 employees + admins (email, in-app, SMS when phone set).
 * Never throws — booking persistence must not depend on notify success.
 */
async function notifyAppointmentStaff({
  pool,
  salesEmail,
  salesSubject,
  salesText,
  icsAttachment,
  appointmentId,
  whenLabel,
  customerName,
  customerPhone,
  topic,
  meetLink,
  skipEmail = false,
}) {
  const outcome = {
    emailSent: false,
    inAppNotified: 0,
    smsSent: 0,
    recipients: [],
  };

  try {
    const [employees] = await pool.execute(
      `SELECT up.id, up.full_name, up.role, up.phone,
              NULLIF(TRIM(COALESCE(eo.email, '')), '') AS official_email,
              NULLIF(TRIM(COALESCE(up.email, '')), '') AS profile_email,
              COALESCE(eo.lead_level, 0)::int AS lead_level
       FROM user_profiles up
       LEFT JOIN employee_onboarding eo ON eo.user_id = up.id
       WHERE up.role = 'employee'
         AND COALESCE(up.is_active, TRUE) = TRUE
         AND COALESCE(eo.lead_level, 0) >= 2
       ORDER BY eo.lead_level ASC, up.full_name ASC
       LIMIT 25`,
    ).catch(() => [[]]);

    const [admins] = await pool.execute(
      `SELECT id, email, phone, full_name, role
       FROM user_profiles
       WHERE role IN ('admin', 'super_admin')
         AND COALESCE(is_active, TRUE) = TRUE
       LIMIT 15`,
    ).catch(() => [[]]);

    const staff = [
      ...(employees || []).map((e) => ({
        id: e.id,
        role: 'employee',
        email: e.official_email || e.profile_email || null,
        phone: e.phone,
        full_name: e.full_name,
        lead_level: e.lead_level,
      })),
      ...(admins || []).map((a) => ({
        id: a.id,
        role: a.role,
        email: a.email,
        phone: a.phone,
        full_name: a.full_name,
        lead_level: null,
      })),
    ];

    if (!skipEmail) {
      const emailTargets = new Set();
      if (salesEmail) emailTargets.add(String(salesEmail).trim().toLowerCase());
      for (const s of staff) {
        if (s.email) emailTargets.add(String(s.email).trim().toLowerCase());
      }

      const primaryTo = String(salesEmail || '').trim().toLowerCase() || [...emailTargets][0];
      const bccList = [...emailTargets].filter((e) => e && e !== primaryTo);

      const primaryMail = await sendAppointmentEmail({
        to: primaryTo,
        bcc: bccList.length ? bccList : undefined,
        subject: salesSubject,
        text: salesText,
        html: `<pre style="font-family:sans-serif;white-space:pre-wrap">${salesText}</pre>`,
        attachments: icsAttachment ? [icsAttachment] : undefined,
        recipientName: 'Rfincare Sales',
      });
      outcome.emailSent = Boolean(primaryMail?.sent);
      outcome.recipients = primaryMail?.sent
        ? [primaryTo, ...(primaryMail?.channel === 'smtp' ? bccList : [])]
        : [];

      if (!outcome.emailSent && primaryTo) {
        const solo = await sendAppointmentEmail({
          to: primaryTo,
          subject: salesSubject,
          text: salesText,
          html: `<pre style="font-family:sans-serif;white-space:pre-wrap">${salesText}</pre>`,
          attachments: icsAttachment ? [icsAttachment] : undefined,
          recipientName: 'Rfincare Sales',
        });
        outcome.emailSent = Boolean(solo?.sent);
        if (solo?.sent) outcome.recipients = [primaryTo];
      }

      const deliveredViaSmtpBcc = Boolean(primaryMail?.sent && primaryMail?.channel === 'smtp');
      if (outcome.emailSent && bccList.length && !deliveredViaSmtpBcc) {
        for (const addr of bccList.slice(0, 10)) {
          try {
            const r = await sendAppointmentEmail({
              to: addr,
              subject: salesSubject,
              text: salesText,
              html: `<pre style="font-family:sans-serif;white-space:pre-wrap">${salesText}</pre>`,
              recipientName: 'Rfincare Team',
            });
            if (r?.sent) outcome.recipients.push(addr);
          } catch {
            /* soft-fail */
          }
        }
      }
    }

    try {
      const { createStaffNotification } = await import('./notifications.js');
      const title = `New expert appointment — ${customerName}`;
      const message = [
        `${customerName} booked a Talk to Expert call.`,
        `When: ${whenLabel} (IST)`,
        `Topic: ${topic}`,
        `Phone: +91-${customerPhone}`,
        meetLink ? `Join: ${meetLink}` : null,
        `Appointment ID: ${appointmentId}`,
      ].filter(Boolean).join('\n');

      for (const s of staff) {
        try {
          await createStaffNotification(pool, {
            userId: s.id,
            role: s.role,
            eventType: 'expert_appointment_booked',
            title,
            message,
            data: {
              appointmentId,
              meetLink: meetLink || null,
              path: '/employee-dashboard',
            },
          });
          outcome.inAppNotified += 1;
        } catch (notifErr) {
          console.warn('[appointments:in-app]', notifErr?.message || notifErr);
        }
      }
    } catch (importErr) {
      console.warn('[appointments:in-app:import]', importErr?.message || importErr);
    }

    if (isMsg91Configured()) {
      const smsBody = [
        `Rfincare: new appointment`,
        `${customerName}`,
        `When: ${whenLabel}`,
        `Topic: ${topic}`,
        meetLink ? `Join: ${meetLink}` : `+91-${customerPhone}`,
      ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 300);

      const seenPhones = new Set();
      for (const s of staff) {
        const phone = String(s.phone || '').replace(/\D/g, '').slice(-10);
        if (!phone || phone.length !== 10 || seenPhones.has(phone)) continue;
        seenPhones.add(phone);
        try {
          const sms = await sendMsg91TransactionalSms({ phone, message: smsBody });
          if (sms?.sent) outcome.smsSent += 1;
        } catch (smsErr) {
          console.warn('[appointments:staff-sms]', smsErr?.message || smsErr);
        }
      }
    }
  } catch (err) {
    console.error('[appointments:staff-notify]', err?.message || err);
  }

  return outcome;
}

async function verifyOtpAndCreateVerification(pool, { email, phone, mobileOtp, emailOtp }) {
  const settings = await getOtpProviderSettings();
  const requireMobileOtp = settings.requireMobileOtp !== false;
  const requireEmailOtp = settings.requireEmailOtp !== false;

  if (requireMobileOtp && !mobileOtp) {
    return { ok: false, error: 'Mobile OTP is required.' };
  }
  if (requireEmailOtp && !emailOtp) {
    return { ok: false, error: 'Email OTP is required.' };
  }

  const attemptKeys = otpTargetKeys({ phone, email }).map((k) => `appointment:${k}`);
  assertOtpVerifyAllowed(attemptKeys);

  if (requireMobileOtp) {
    const [[smsRow]] = await pool.execute(
      `SELECT id FROM appointment_otps
       WHERE email = :email AND phone = :phone AND channel = 'sms' AND purpose = 'appointment_booking'
         AND otp_hash = :hash AND verified_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      { email, phone, hash: hashOtp(mobileOtp) },
    );
    if (!smsRow?.id) {
      return { ok: false, error: failedOtpMessage(attemptKeys, 'Invalid or expired mobile OTP.') };
    }
    await pool.execute(`UPDATE appointment_otps SET verified_at = NOW() WHERE id = :id`, { id: smsRow.id });
  }

  if (requireEmailOtp) {
    const [[emailRow]] = await pool.execute(
      `SELECT id FROM appointment_otps
       WHERE email = :email AND phone = :phone AND channel = 'email' AND purpose = 'appointment_booking'
         AND otp_hash = :hash AND verified_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      { email, phone, hash: hashOtp(emailOtp) },
    );
    if (!emailRow?.id) {
      return { ok: false, error: failedOtpMessage(attemptKeys, 'Invalid or expired email OTP.') };
    }
    await pool.execute(`UPDATE appointment_otps SET verified_at = NOW() WHERE id = :id`, {
      id: emailRow.id,
    });
  }
  clearOtpVerifyFailures(attemptKeys);

  const verificationId = newId();
  const verificationExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await pool.execute(
    `INSERT INTO appointment_otp_verifications (id, email, phone, expires_at)
     VALUES (:id, :email, :phone, :expires_at)`,
    {
      id: verificationId,
      email,
      phone,
      expires_at: verificationExpiresAt,
    },
  );

  return { ok: true, verificationId, expiresInSeconds: 900 };
}

appointmentsRouter.get('/slots', async (_req, res, next) => {
  try {
    const slots = [];
    const now = new Date();
    const hours = ['09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00'];

    for (let dayOffset = 0; dayOffset < 14; dayOffset += 1) {
      const day = new Date(now);
      day.setDate(day.getDate() + dayOffset);
      // Skip Sundays (0)
      if (day.getDay() === 0) continue;

      const y = day.getFullYear();
      const m = String(day.getMonth() + 1).padStart(2, '0');
      const d = String(day.getDate()).padStart(2, '0');
      const date = `${y}-${m}-${d}`;

      for (const time of hours) {
        const starts = combineDateTimeIst(date, time);
        if (starts.getTime() < Date.now() + 60 * 60 * 1000) continue;
        slots.push({ date, time, label: `${formatDisplay(starts)}` });
      }
    }

    res.json({ slots: slots.slice(0, 56) });
  } catch (err) {
    next(err);
  }
});

appointmentsRouter.post('/otp/request', async (req, res, next) => {
  try {
    await ensureAppointmentsSchema();
    const input = OtpRequestSchema.parse(req.body);
    const startsAt = combineDateTimeIst(input.preferredDate, input.preferredTime);
    if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() < Date.now()) {
      return res.status(400).json({ error: 'Please choose a future date and time slot.' });
    }

    const settings = await getOtpProviderSettings();
    let otpResult;
    try {
      otpResult = await sendDualChannelOtp({
        phone: input.phone,
        email: input.email,
        settings,
        publicFacing: true,
      });
    } catch (otpErr) {
      console.error('[appointments:otp]', otpErr?.message || otpErr);
      return sendPublicOtpFailure(res, otpErr);
    }

    const pool = getPool();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    if (otpResult.requireMobileOtp && otpResult.mobileOtp) {
      await pool.execute(
        `INSERT INTO appointment_otps (id, email, phone, otp_hash, channel, purpose, expires_at)
         VALUES (:id, :email, :phone, :hash, 'sms', 'appointment_booking', :expires_at)`,
        {
          id: newId(),
          email: input.email,
          phone: input.phone,
          hash: hashOtp(otpResult.mobileOtp),
          expires_at: expiresAt,
        },
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
          expires_at: expiresAt,
        },
      );
    }

    // Same privacy model as forgot-password: never return provider warnings to the customer.
    res.json({
      success: true,
      message: 'OTP sent. Please verify to confirm your appointment.',
      expiresInSeconds: 600,
      requireMobileOtp: otpResult.requireMobileOtp,
      requireEmailOtp: otpResult.requireEmailOtp,
      ...(canExposeDevOtp()
        ? {
            devMobileOtp: otpResult.mobileOtp || undefined,
            devEmailOtp: otpResult.emailOtp || undefined,
          }
        : {}),
    });
  } catch (err) {
    next(err);
  }
});

appointmentsRouter.post('/otp/verify', async (req, res, next) => {
  try {
    await ensureAppointmentsSchema();
    const input = OtpVerifySchema.parse(req.body);
    const pool = getPool();
    const verify = await verifyOtpAndCreateVerification(pool, input);
    if (!verify.ok) {
      return res.status(401).json({ error: verify.error || 'Invalid or expired OTP.' });
    }
    res.json({
      success: true,
      otpVerificationId: verify.verificationId,
      expiresInSeconds: verify.expiresInSeconds,
    });
  } catch (err) {
    next(err);
  }
});

appointmentsRouter.post('/', async (req, res, next) => {
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
        phone: input.phone,
      },
    );
    if (!verification?.id) {
      return res.status(401).json({ error: 'OTP verification is required before booking.' });
    }

    const durationMinutes = 30;
    const startsAt = combineDateTimeIst(input.preferredDate, input.preferredTime);
    if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() < Date.now()) {
      return res.status(400).json({ error: 'Please choose a future date and time slot.' });
    }
    const endsAt = new Date(startsAt.getTime() + durationMinutes * 60 * 1000);

    const contact = await getSiteContactSettings();
    const salesEmail = salesTeamEmail(contact);
    const id = newId();

    const topicLabel = input.topic;
    const summary = `Rfincare Expert Call — ${input.fullName}`;
    const descriptionBase = [
      `Customer: ${input.fullName}`,
      `Email: ${input.email}`,
      `Phone: +91-${input.phone}`,
      `Topic: ${topicLabel}`,
      input.notes ? `Notes: ${input.notes}` : null,
      '',
      'Booked via Rfincare Talk to Expert.',
    ]
      .filter(Boolean)
      .join('\n');

    let google = { created: false };
    try {
      google = await createGoogleCalendarEvent({
        summary,
        description: descriptionBase,
        startIso: startsAt.toISOString(),
        endIso: endsAt.toISOString(),
        attendeeEmails: [input.email, SUPPORT_EMAIL, salesEmail].filter(Boolean),
        location: 'Rfincare — Online video consultation',
        createMeetLink: true,
        requestId: id,
      });
    } catch (err) {
      console.warn('[appointments] Google Calendar sync failed:', err?.message || err);
      google = { created: false, reason: err?.message || 'calendar_error' };
    }

    const video = resolveAppointmentVideoLink({
      appointmentId: id,
      hangoutLink: google.hangoutLink || google.meetLink || null,
    });
    const meetLink = video.url;
    const description = [
      descriptionBase,
      '',
      `Video call: ${meetLink}`,
    ].join('\n');

    await pool.execute(
      `INSERT INTO expert_appointments (
         id, full_name, email, phone, topic, preferred_date, preferred_time,
         duration_minutes, notes, status, google_event_id, google_event_link,
         meet_link, starts_at, ends_at
       ) VALUES (
         :id, :full_name, :email, :phone, :topic, :preferred_date, :preferred_time,
         :duration_minutes, :notes, 'scheduled', :google_event_id, :google_event_link,
         :meet_link, :starts_at, :ends_at
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
        meet_link: meetLink,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
      },
    );

    const whenLabel = formatDisplay(startsAt);
    const dateLabel = startsAt.toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    const timeLabel = startsAt.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
    });

    const ics = buildIcsInvite({
      uid: `${id}@rfincare.com`,
      summary,
      description,
      location: meetLink,
      start: startsAt,
      end: endsAt,
      organizerEmail: SUPPORT_EMAIL,
      attendeeEmails: [input.email, SUPPORT_EMAIL, salesEmail],
      url: meetLink,
    });
    const icsAttachment = {
      filename: 'rfincare-appointment.ics',
      content: Buffer.from(ics, 'utf8'),
      contentType: 'text/calendar; charset=utf-8; method=REQUEST',
    };

    const customerSubject = `Appointment confirmed — ${whenLabel}`;
    const customerLines = [
      `Hi ${input.fullName},`,
      '',
      'Your consultation with an Rfincare financial expert is confirmed.',
      '',
      `Date: ${dateLabel}`,
      `Time: ${timeLabel} (IST)`,
      `Topic: ${topicLabel}`,
      `Duration: ${durationMinutes} minutes`,
      `Join video call: ${meetLink}`,
      google.htmlLink ? `Calendar event: ${google.htmlLink}` : null,
      '',
      'Our team will also be on the call. Need to reschedule? Reply to this email or write to support@rfincare.com.',
    ];
    const customerText = customerLines.filter(Boolean).join('\n');
    const customerHtml = buildAppointmentEmailHtml({
      title: 'Appointment confirmed',
      whenLabel,
      meetUrl: meetLink,
      lines: [
        `Topic: ${topicLabel}`,
        `Duration: ${durationMinutes} minutes`,
        `Date: ${dateLabel}`,
        `Time: ${timeLabel} (IST)`,
        'Need to reschedule? Reply to this email or contact support@rfincare.com.',
      ],
    });

    const salesSubject = `New expert appointment — ${input.fullName} · ${whenLabel}`;
    const salesLines = [
      'A customer booked a Talk to Expert appointment.',
      '',
      `Name: ${input.fullName}`,
      `Email: ${input.email}`,
      `Phone: +91-${input.phone}`,
      `Date: ${dateLabel}`,
      `Time: ${timeLabel} (IST)`,
      `Topic: ${topicLabel}`,
      input.notes ? `Notes: ${input.notes}` : null,
      `Join video call: ${meetLink}`,
      google.htmlLink ? `Google Calendar: ${google.htmlLink}` : null,
      google.created ? null : 'Note: Google Calendar sync was skipped or failed — use the video link and ICS attachment.',
      '',
      `Appointment ID: ${id}`,
    ];
    const salesText = salesLines.filter(Boolean).join('\n');
    const salesHtml = buildAppointmentEmailHtml({
      title: 'New expert appointment',
      whenLabel,
      meetUrl: meetLink,
      lines: [
        `Customer: ${input.fullName}`,
        `Email: ${input.email}`,
        `Phone: +91-${input.phone}`,
        `Topic: ${topicLabel}`,
        input.notes ? `Notes: ${input.notes}` : null,
        `Appointment ID: ${id}`,
      ],
    });

    // Customer confirmation (ICS attached when provider supports it). Soft-fail only.
    let customerMail = { sent: false, reason: 'not_attempted' };
    try {
      customerMail = await sendAppointmentEmail({
        to: input.email,
        subject: customerSubject,
        text: customerText,
        html: customerHtml,
        attachments: [icsAttachment],
        recipientName: input.fullName,
        replyTo: SUPPORT_EMAIL,
      });
    } catch (mailErr) {
      console.error('[appointments:email:customer]', mailErr?.message || mailErr);
      customerMail = { sent: false, reason: 'email_error', warningInternal: mailErr?.message };
    }

    // Always notify support@rfincare.com (client requirement) + configured sales inbox.
    const companyRecipients = [...new Set(
      [SUPPORT_EMAIL, salesEmail]
        .map((e) => String(e || '').trim().toLowerCase())
        .filter(Boolean),
    )];

    let supportMail = { sent: false };
    try {
      supportMail = await sendAppointmentEmail({
        to: companyRecipients,
        subject: salesSubject,
        text: salesText,
        html: salesHtml,
        attachments: [icsAttachment],
        recipientName: 'Rfincare Support',
      });
    } catch (mailErr) {
      console.error('[appointments:email:support]', mailErr?.message || mailErr);
      supportMail = { sent: false, reason: 'email_error' };
    }

    // Sales / employee / admin notifications (email + in-app + SMS). Soft-fail only.
    const staffNotify = await notifyAppointmentStaff({
      pool,
      salesEmail: SUPPORT_EMAIL,
      salesSubject,
      salesText,
      icsAttachment,
      appointmentId: id,
      whenLabel,
      customerName: input.fullName,
      customerPhone: input.phone,
      topic: topicLabel,
      meetLink,
      // Company email already sent to support@rfincare.com (+ sales) above.
      skipEmail: true,
    });

    // Best-effort SMS confirmation to customer (never surface MSG91 internals).
    let sms = { sent: false, reason: 'sms_not_sent' };
    try {
      const smsText = [
        `Rfincare: appointment confirmed.`,
        `When: ${whenLabel} (IST)`,
        `Topic: ${topicLabel}`,
        `Join: ${meetLink}`,
      ].join('\n');

      sms = await sendMsg91TransactionalSms({
        phone: input.phone,
        message: smsText.slice(0, 300),
      });
    } catch (smsErr) {
      console.error('[appointments:sms]', smsErr?.message || smsErr);
      sms = {
        sent: false,
        reason: 'sms_error',
      };
    }

    const customerEmailSent = customerMail?.sent === true;
    const salesEmailSent = supportMail?.sent === true || staffNotify.emailSent === true;
    const icsAttached =
      customerEmailSent
      && Number(customerMail?.attachmentCount || 0) > 0
      && !customerMail?.attachmentsDropped;
    const anyEmailFailed = !customerEmailSent || !salesEmailSent;

    await pool.execute(
      `UPDATE appointment_otp_verifications SET used_at = NOW() WHERE id = :id`,
      { id: verification.id },
    );

    res.status(201).json({
      id,
      status: 'scheduled',
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      whenLabel,
      dateLabel,
      timeLabel,
      meetLink,
      videoProvider: video.provider,
      googleCalendar: {
        configured: googleCalendarConfigured(),
        synced: Boolean(google.created),
        eventLink: google.htmlLink || null,
        meetLink: google.hangoutLink || google.meetLink || null,
      },
      emails: {
        customer: {
          sent: customerEmailSent,
          channel: customerMail?.channel || null,
          calendarInviteAttached: icsAttached,
        },
        sales: {
          sent: salesEmailSent,
          channel: supportMail?.channel || (salesEmailSent ? 'email' : null),
          inAppNotified: staffNotify.inAppNotified,
          smsSent: staffNotify.smsSent,
        },
        salesEmail: SUPPORT_EMAIL,
        companyRecipients,
      },
      sms: { sent: Boolean(sms?.sent) },
      staffNotify: {
        emailSent: salesEmailSent,
        inAppNotified: staffNotify.inAppNotified,
        smsSent: staffNotify.smsSent,
      },
      message: anyEmailFailed
        ? 'Appointment booked. If you do not receive a confirmation email shortly, our team will still contact you at the scheduled time.'
        : 'Appointment booked. Confirmation emails sent to you and support@rfincare.com.',
      // Customer-safe notices only (no SMTP/MSG91 credential text).
      notificationWarnings: {
        emailWarnings: [
          customerEmailSent ? null : publicEmailDeliveryMessage(customerMail),
          salesEmailSent
            ? null
            : 'Sales team notification email could not be delivered right now. Your booking is still confirmed.',
        ].filter(Boolean),
        smsWarning: sms?.sent
          ? null
          : 'SMS confirmation could not be sent right now. Your appointment is still confirmed.',
      },
    });
  } catch (err) {
    if (err?.name === 'ZodError') {
      return res.status(400).json({ error: err.errors?.[0]?.message || 'Invalid booking details' });
    }
    next(err);
  }
});
