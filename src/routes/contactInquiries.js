import { Router } from 'express';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { newId } from '../lib/ids.js';
import { sendEmail } from '../lib/email.js';
import { getSiteContactSettings } from '../lib/siteContactSettings.js';
import { hashOtp, sendDualChannelOtp } from '../lib/otp.js';
import { getOtpProviderSettings } from '../lib/otpProviderSettings.js';

export const contactInquiriesRouter = Router();

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
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'),
  subject: z.string().trim().min(2).max(200),
  message: z.string().trim().min(5).max(4000),
  consentAccepted: z.literal(true),
  otpVerificationId: z.string().trim().min(10),
});

const OtpRequestSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'),
  subject: z.string().trim().min(2).max(200),
  message: z.string().trim().min(5).max(4000),
  consentAccepted: z.literal(true),
});

const OtpVerifySchema = z.object({
  email: z.string().trim().email().max(255),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'),
  mobileOtp: z.string().trim().length(6).optional(),
  emailOtp: z.string().trim().length(6).optional(),
});

function supportInbox(contact) {
  return (
    process.env.CONTACT_INQUIRY_EMAIL
    || process.env.SALES_TEAM_EMAIL
    || contact?.emails?.[0]
    || contact?.email
    || 'support@rfincare.com'
  );
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

  if (requireMobileOtp) {
    const [[smsRow]] = await pool.execute(
      `SELECT id FROM contact_inquiry_otps
       WHERE email = :email AND phone = :phone AND channel = 'sms' AND purpose = 'contact_inquiry'
         AND otp_hash = :hash AND verified_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      { email, phone, hash: hashOtp(mobileOtp) },
    );
    if (!smsRow?.id) return { ok: false, error: 'Invalid or expired mobile OTP.' };
    await pool.execute(`UPDATE contact_inquiry_otps SET verified_at = NOW() WHERE id = :id`, {
      id: smsRow.id,
    });
  }

  if (requireEmailOtp) {
    const [[emailRow]] = await pool.execute(
      `SELECT id FROM contact_inquiry_otps
       WHERE email = :email AND phone = :phone AND channel = 'email' AND purpose = 'contact_inquiry'
         AND otp_hash = :hash AND verified_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      { email, phone, hash: hashOtp(emailOtp) },
    );
    if (!emailRow?.id) return { ok: false, error: 'Invalid or expired email OTP.' };
    await pool.execute(`UPDATE contact_inquiry_otps SET verified_at = NOW() WHERE id = :id`, {
      id: emailRow.id,
    });
  }

  const verificationId = newId();
  const verificationExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
  await pool.execute(
    `INSERT INTO contact_inquiry_otp_verifications (id, email, phone, expires_at)
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

contactInquiriesRouter.post('/otp/request', async (req, res, next) => {
  try {
    await ensureContactInquirySchema();
    const input = OtpRequestSchema.parse(req.body);
    const settings = await getOtpProviderSettings();
    const otpResult = await sendDualChannelOtp({
      phone: input.phone,
      email: input.email,
      settings,
    });

    const pool = getPool();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    if (otpResult.requireMobileOtp && otpResult.mobileOtp) {
      await pool.execute(
        `INSERT INTO contact_inquiry_otps (id, email, phone, otp_hash, channel, purpose, expires_at)
         VALUES (:id, :email, :phone, :hash, 'sms', 'contact_inquiry', :expires_at)`,
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
        `INSERT INTO contact_inquiry_otps (id, email, phone, otp_hash, channel, purpose, expires_at)
         VALUES (:id, :email, :phone, :hash, 'email', 'contact_inquiry', :expires_at)`,
        {
          id: newId(),
          email: input.email,
          phone: input.phone,
          hash: hashOtp(otpResult.emailOtp),
          expires_at: expiresAt,
        },
      );
    }

    res.json({
      success: true,
      message: 'OTP sent successfully.',
      expiresInSeconds: 600,
      requireMobileOtp: otpResult.requireMobileOtp,
      requireEmailOtp: otpResult.requireEmailOtp,
      warnings:
        Array.isArray(otpResult.warnings) && otpResult.warnings.length
          ? otpResult.warnings
          : undefined,
      ...(process.env.LOG_OTP === 'true'
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

contactInquiriesRouter.post('/otp/verify', async (req, res, next) => {
  try {
    await ensureContactInquirySchema();
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

contactInquiriesRouter.post('/', async (req, res, next) => {
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
        phone: input.phone,
      },
    );
    if (!verification?.id) {
      return res.status(401).json({ error: 'OTP verification is required before sending your message.' });
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
        message: input.message,
      },
    );

    await pool.execute(
      `UPDATE contact_inquiry_otp_verifications SET used_at = NOW() WHERE id = :id`,
      { id: verification.id },
    );

    const contact = await getSiteContactSettings();
    const inbox = supportInbox(contact);
    const notificationWarnings = [];

    let customerEmailSent = false;
    let supportEmailSent = false;
    try {
      const customerMail = await sendEmail({
        to: input.email,
        subject: `We received your message — ${input.subject}`,
        text: [
          `Hi ${input.fullName},`,
          '',
          'Thank you for contacting Rfincare. We have received your message and will respond soon.',
          '',
          `Subject: ${input.subject}`,
          `Phone: ${input.phone}`,
          '',
          'Your message:',
          input.message,
          '',
          '— Rfincare Support',
        ].join('\n'),
      });
      customerEmailSent = Boolean(customerMail?.sent);
      if (!customerEmailSent && customerMail?.warning) {
        notificationWarnings.push(customerMail.warning);
      }
    } catch (err) {
      notificationWarnings.push(err?.message || 'Customer confirmation email failed.');
    }

    try {
      const supportMail = await sendEmail({
        to: inbox,
        subject: `[Contact] ${input.subject} — ${input.fullName}`,
        text: [
          'New contact form inquiry (OTP verified)',
          '',
          `Name: ${input.fullName}`,
          `Email: ${input.email}`,
          `Phone: ${input.phone}`,
          `Subject: ${input.subject}`,
          '',
          'Message:',
          input.message,
          '',
          `Inquiry ID: ${inquiryId}`,
        ].join('\n'),
      });
      supportEmailSent = Boolean(supportMail?.sent);
      if (!supportEmailSent && supportMail?.warning) {
        notificationWarnings.push(supportMail.warning);
      }
    } catch (err) {
      notificationWarnings.push(err?.message || 'Support notification email failed.');
    }

    res.status(201).json({
      success: true,
      inquiryId,
      message: 'Your message has been sent successfully.',
      emails: {
        customer: { sent: customerEmailSent },
        support: { sent: supportEmailSent, to: inbox },
      },
      notificationWarnings: notificationWarnings.length ? notificationWarnings : undefined,
    });
  } catch (err) {
    next(err);
  }
});
