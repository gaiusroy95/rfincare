import { Router } from "express";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { newId } from "../lib/ids.js";
import { sendEmail } from "../lib/email.js";
import { sendMsg91TransactionalSms, isMsg91Configured } from "../lib/msg91.js";
import { getSiteContactSettings } from "../lib/siteContactSettings.js";
import { hashOtp, sendDualChannelOtp, toPublicOtpMessage } from "../lib/otp.js";
import { getOtpProviderSettings } from "../lib/otpProviderSettings.js";
const contactInquiriesRouter = Router();
let schemaReady = false;
async function ensureContactInquirySchema() {
  if (schemaReady) return;
  const pool = getPool();
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS contact_inquiries (
      id VARCHAR(36) PRIMARY KEY,
      full_name VARCHAR(200) NOT NULL,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      subject VARCHAR(200) NOT NULL,
      message TEXT NOT NULL,
      consent_accepted BOOLEAN NOT NULL DEFAULT TRUE,
      status VARCHAR(32) NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS contact_inquiry_otps (
      id VARCHAR(36) PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      otp_hash VARCHAR(128) NOT NULL,
      channel VARCHAR(32) NOT NULL,
      purpose VARCHAR(64) NOT NULL DEFAULT 'contact_inquiry',
      expires_at TIMESTAMPTZ NOT NULL,
      verified_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS contact_inquiry_otp_verifications (
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
const ContactSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number"),
  subject: z.string().trim().min(2).max(200),
  message: z.string().trim().min(5).max(4e3),
  consentAccepted: z.literal(true),
  otpVerificationId: z.string().trim().min(10)
});
const OtpRequestSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number"),
  subject: z.string().trim().min(2).max(200),
  message: z.string().trim().min(5).max(4e3),
  consentAccepted: z.literal(true)
});
const OtpVerifySchema = z.object({
  email: z.string().trim().email().max(255),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number"),
  mobileOtp: z.string().trim().length(6).optional(),
  emailOtp: z.string().trim().length(6).optional()
});
function supportInboxes(contact) {
  const extras = [
    process.env.CONTACT_INQUIRY_EMAIL,
    process.env.SALES_TEAM_EMAIL,
    ...Array.isArray(contact?.emails) ? contact.emails : [],
    contact?.email
  ].map((v) => String(v || "").trim().toLowerCase()).filter((v) => v.includes("@"));
  return [.../* @__PURE__ */ new Set(["support@rfincare.com", ...extras])];
}
function supportSmsPhone(contact) {
  const fromEnv = String(process.env.CONTACT_INQUIRY_SMS || "").replace(/\D/g, "").slice(-10);
  if (fromEnv.length === 10) return fromEnv;
  const fromContact = String(contact?.phone || contact?.phones?.[0] || "").replace(/\D/g, "").slice(-10);
  if (fromContact.length === 10) return fromContact;
  return "7300069952";
}
async function notifySupportSms({ phone, fullName, customerPhone, subject, inquiryId }) {
  if (!isMsg91Configured()) {
    console.warn("[contact:support-sms] MSG91 not configured — skipped");
    return { sent: false };
  }
  const body = [
    "Rfincare new contact enquiry",
    `From: ${fullName} (${customerPhone})`,
    `Subject: ${String(subject || "").slice(0, 80)}`,
    `ID: ${inquiryId}`
  ].join("\n");
  try {
    return await sendMsg91TransactionalSms({
      phone,
      message: body.slice(0, 500)
    });
  } catch (err) {
    console.error("[contact:support-sms]", err?.message || err);
    return { sent: false };
  }
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
      `SELECT id FROM contact_inquiry_otps
       WHERE email = :email AND phone = :phone AND channel = 'sms' AND purpose = 'contact_inquiry'
         AND otp_hash = :hash AND verified_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      { email, phone, hash: hashOtp(mobileOtp) }
    );
    if (!smsRow?.id) return { ok: false, error: "Invalid or expired mobile OTP." };
    await pool.execute(`UPDATE contact_inquiry_otps SET verified_at = NOW() WHERE id = :id`, {
      id: smsRow.id
    });
  }
  if (requireEmailOtp) {
    const [[emailRow]] = await pool.execute(
      `SELECT id FROM contact_inquiry_otps
       WHERE email = :email AND phone = :phone AND channel = 'email' AND purpose = 'contact_inquiry'
         AND otp_hash = :hash AND verified_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      { email, phone, hash: hashOtp(emailOtp) }
    );
    if (!emailRow?.id) return { ok: false, error: "Invalid or expired email OTP." };
    await pool.execute(`UPDATE contact_inquiry_otps SET verified_at = NOW() WHERE id = :id`, {
      id: emailRow.id
    });
  }
  const verificationId = newId();
  const verificationExpiresAt = new Date(Date.now() + 15 * 60 * 1e3);
  await pool.execute(
    `INSERT INTO contact_inquiry_otp_verifications (id, email, phone, expires_at)
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
contactInquiriesRouter.post("/otp/request", async (req, res, next) => {
  try {
    await ensureContactInquirySchema();
    const input = OtpRequestSchema.parse(req.body);
    const settings = await getOtpProviderSettings();
    let otpResult;
    try {
      otpResult = await sendDualChannelOtp({
        phone: input.phone,
        email: input.email,
        settings,
        publicFacing: true
      });
    } catch (otpErr) {
      console.error("[contact:otp]", otpErr?.message || otpErr);
      return res.status(502).json({
        error: toPublicOtpMessage(otpErr?.message)
      });
    }
    const pool = getPool();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1e3);
    if (otpResult.requireMobileOtp && otpResult.mobileOtp) {
      await pool.execute(
        `INSERT INTO contact_inquiry_otps (id, email, phone, otp_hash, channel, purpose, expires_at)
         VALUES (:id, :email, :phone, :hash, 'sms', 'contact_inquiry', :expires_at)`,
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
        `INSERT INTO contact_inquiry_otps (id, email, phone, otp_hash, channel, purpose, expires_at)
         VALUES (:id, :email, :phone, :hash, 'email', 'contact_inquiry', :expires_at)`,
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
      message: "OTP sent. Please verify to send your message.",
      expiresInSeconds: 600,
      requireMobileOtp: otpResult.requireMobileOtp,
      requireEmailOtp: otpResult.requireEmailOtp,
      ...process.env.LOG_OTP === "true" ? {
        devMobileOtp: otpResult.mobileOtp || void 0,
        devEmailOtp: otpResult.emailOtp || void 0
      } : {}
    });
  } catch (err) {
    next(err);
  }
});
contactInquiriesRouter.post("/otp/verify", async (req, res, next) => {
  try {
    await ensureContactInquirySchema();
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
contactInquiriesRouter.post("/", async (req, res, next) => {
  try {
    await ensureContactInquirySchema();
    const input = ContactSchema.parse(req.body);
    const pool = getPool();
    const [[verification]] = await pool.execute(
      `SELECT id FROM contact_inquiry_otp_verifications
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
      return res.status(401).json({ error: "OTP verification is required before sending your message." });
    }
    const inquiryId = newId();
    await pool.execute(
      `INSERT INTO contact_inquiries
        (id, full_name, email, phone, subject, message, consent_accepted)
       VALUES
        (:id, :full_name, :email, :phone, :subject, :message, TRUE)`,
      {
        id: inquiryId,
        full_name: input.fullName,
        email: input.email,
        phone: input.phone,
        subject: input.subject,
        message: input.message
      }
    );
    await pool.execute(
      `UPDATE contact_inquiry_otp_verifications SET used_at = NOW() WHERE id = :id`,
      { id: verification.id }
    );
    const contact = await getSiteContactSettings();
    const inboxes = supportInboxes(contact);
    const smsPhone = supportSmsPhone(contact);
    const supportSubject = `[Contact] ${input.subject} — ${input.fullName}`;
    const supportText = [
      "New contact form inquiry (OTP verified)",
      "",
      `Name: ${input.fullName}`,
      `Email: ${input.email}`,
      `Phone: ${input.phone}`,
      `Subject: ${input.subject}`,
      "",
      "Message:",
      input.message,
      "",
      `Inquiry ID: ${inquiryId}`,
      "",
      "Reply directly to the customer email above."
    ].join("\n");
    let customerEmailSent = false;
    let supportEmailSent = false;
    let supportSmsSent = false;
    try {
      const supportMail = await sendEmail({
        to: inboxes,
        subject: supportSubject,
        text: supportText,
        replyTo: input.email,
        recipientName: "Rfincare Support"
      });
      supportEmailSent = Boolean(supportMail?.sent);
      if (!supportEmailSent && supportMail?.warningInternal) {
        console.warn("[contact:support-mail]", supportMail.warningInternal, { inquiryId, inboxes });
      } else if (supportEmailSent) {
        console.info("[contact:support-mail] delivered", { inquiryId, to: inboxes, channel: supportMail?.channel });
      }
    } catch (err) {
      console.error("[contact:support-mail]", err?.message || err, { inquiryId });
    }
    try {
      const bccSupport = !supportEmailSent;
      const customerMail = await sendEmail({
        to: input.email,
        bcc: bccSupport ? inboxes : void 0,
        subject: `We received your message — ${input.subject}`,
        text: [
          `Hi ${input.fullName},`,
          "",
          "Thank you for contacting Rfincare. We have received your message and will respond soon.",
          "",
          `Subject: ${input.subject}`,
          `Phone: ${input.phone}`,
          "",
          "Your message:",
          input.message,
          "",
          "— Rfincare Support"
        ].join("\n"),
        recipientName: input.fullName,
        replyTo: inboxes[0]
      });
      customerEmailSent = Boolean(customerMail?.sent);
      if (!customerEmailSent && customerMail?.warningInternal) {
        console.warn("[contact:customer-mail]", customerMail.warningInternal);
      }
      if (bccSupport && customerEmailSent) {
        supportEmailSent = true;
        console.info("[contact:support-mail] notified via customer BCC", { inquiryId, inboxes });
      }
    } catch (err) {
      console.error("[contact:customer-mail]", err?.message || err);
    }
    if (!supportEmailSent) {
      try {
        const retry = await sendEmail({
          to: "support@rfincare.com",
          subject: supportSubject,
          text: supportText,
          replyTo: input.email,
          recipientName: "Rfincare Support"
        });
        supportEmailSent = Boolean(retry?.sent);
        if (!supportEmailSent) {
          console.error("[contact:support-mail:retry-failed]", retry?.warningInternal || retry?.reason, {
            inquiryId
          });
        }
      } catch (err) {
        console.error("[contact:support-mail:retry]", err?.message || err);
      }
    }
    const smsResult = await notifySupportSms({
      phone: smsPhone,
      fullName: input.fullName,
      customerPhone: input.phone,
      subject: input.subject,
      inquiryId
    });
    supportSmsSent = Boolean(smsResult?.sent);
    res.status(201).json({
      success: true,
      inquiryId,
      message: "Your message has been sent successfully.",
      emails: {
        customer: { sent: customerEmailSent },
        support: { sent: supportEmailSent, to: inboxes }
      },
      sms: { sent: supportSmsSent }
    });
  } catch (err) {
    next(err);
  }
});
export {
  contactInquiriesRouter
};
