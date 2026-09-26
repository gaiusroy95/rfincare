import crypto from 'crypto';

import { getPool } from '../db/pool.js';
import { newId } from './ids.js';
import {
  generateOtp,
  getOtpProviderSettings,
  isSyntheticLeadEmail,
  sendOtpNotification,
  toPublicOtpMessage,
} from './otp.js';
import { sendMsg91Flow, sendMsg91TransactionalSms, getMsg91Config } from './msg91.js';

const PURPOSE = 'cibil_consent';
/** Public homepage CIBIL form — mobile (+ email when present / required by OTP settings). */
const HOMEPAGE_PURPOSE = 'homepage_cibil';
const OTP_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS = 15 * 60 * 1000;
const CONSENT_SLUG = 'consent-data-collection-credit-bureau';

function hashOtp(otp) {
  return crypto.createHash('sha256').update(String(otp)).digest('hex');
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hmacSecret() {
  return process.env.JWT_ACCESS_SECRET || 'rfincare-cibil-consent';
}

function buildHomepageContactToken({ phone, email, smsOtpId, emailOtpId }) {
  return crypto
    .createHmac('sha256', hmacSecret())
    .update(`${phone}|${normalizeEmail(email)}|${smsOtpId || ''}|${emailOtpId || ''}|homepage_cibil`)
    .digest('hex');
}

export function getCibilConsentLink() {
  const base = String(
    process.env.PUBLIC_APP_URL
      || process.env.FRONTEND_URL
      || process.env.PUBLIC_FRONTEND_URL
      || 'https://rfincare.com',
  ).replace(/\/$/, '');
  return `${base}/legal/${CONSENT_SLUG}`;
}

function buildConsentOtpMessage(otp, consentLink) {
  const tpl =
    process.env.MSG91_CIBIL_CONSENT_SMS_TEMPLATE
    || 'Rfincare CIBIL OTP: {{otp}}. Consent: {{consentLink}}. Valid 10 min. -RFINCR';
  return String(tpl)
    .replace(/\{\{otp\}\}/gi, String(otp))
    .replace(/\{\{consentLink\}\}/gi, consentLink)
    .replace(/\{\{consent_link\}\}/gi, consentLink)
    .replace(/\{\{CONSENT_LINK\}\}/g, consentLink);
}

/**
 * Send CIBIL consent OTP via MSG91 (new consent message with link) or configured OTP providers.
 */
export async function sendCibilConsentOtpSms({ phone, otp }) {
  const settings = await getOtpProviderSettings();
  const consentLink = getCibilConsentLink();
  const message = buildConsentOtpMessage(otp, consentLink);
  const mobile = normalizePhone(phone);

  const cfg = settings.providerConfig || {};
  const flowId =
    process.env.MSG91_CIBIL_CONSENT_FLOW_ID
    || cfg.msg91CibilConsentFlowId
    || cfg.msg91_cibil_consent_flow_id
    || '';

  if (settings.smsProvider === 'msg91') {
    if (flowId) {
      try {
        await sendMsg91Flow({
          phone: mobile,
          variables: {
            var: String(otp),
            OTP: String(otp),
            otp: String(otp),
            CONSENT_LINK: consentLink,
            consent_link: consentLink,
            consentLink,
          },
          config: {
            ...cfg,
            msg91FlowTemplateId: flowId,
          },
        });
        return {
          sent: true,
          provider: 'msg91',
          mode: 'cibil_consent_flow',
          consentLink,
        };
      } catch (err) {
        // Fall through to transactional consent SMS.
        console.warn('[cibil-consent-otp] flow failed, falling back to SMS:', err?.message);
      }
    }

    // Dedicated transactional SMS so the consent URL is always included
    // (standard OTP template often has no link slot).
    try {
      getMsg91Config(cfg);
      await sendMsg91TransactionalSms({
        phone: mobile,
        message,
        otp,
        config: cfg,
      });
      return {
        sent: true,
        provider: 'msg91',
        mode: 'cibil_consent_sms',
        consentLink,
      };
    } catch (err) {
      console.warn('[cibil-consent-otp] transactional SMS failed, falling back to OTP channel:', err?.message);
    }
  }

  const result = await sendOtpNotification({
    phone: mobile,
    otp,
    channel: 'sms',
    settings,
  });
  return { ...result, consentLink, mode: result?.mode || 'otp_channel' };
}

export async function requestCibilConsentOtp({ phone, initiatedByUserId = null }) {
  const mobile = normalizePhone(phone);
  if (!/^[6-9]\d{9}$/.test(mobile)) {
    const e = new Error('Enter a valid 10-digit mobile number');
    e.status = 400;
    throw e;
  }

  const pool = getPool();
  const otp = generateOtp();
  const id = newId();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await pool.execute(
    `INSERT INTO lead_otps (id, lead_id, email, phone, otp_hash, purpose, channel, expires_at)
     VALUES (:id, NULL, NULL, :phone, :hash, :purpose, 'sms', :expires)`,
    {
      id,
      phone: mobile,
      hash: hashOtp(otp),
      purpose: PURPOSE,
      expires: expiresAt.toISOString(),
    },
  );

  const sendResult = await sendCibilConsentOtpSms({ phone: mobile, otp });

  if (process.env.LOG_OTP === 'true' || process.env.NODE_ENV !== 'production') {
    console.log('[cibil-consent-otp]', {
      phone: `******${mobile.slice(-4)}`,
      consentLink: sendResult.consentLink,
      initiatedByUserId,
      otp: process.env.LOG_OTP === 'true' ? otp : '(hidden)',
    });
  }

  return {
    sent: true,
    phone: mobile,
    expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
    consentLink: sendResult.consentLink || getCibilConsentLink(),
    delivery: {
      provider: sendResult.provider || null,
      mode: sendResult.mode || null,
    },
  };
}

export async function verifyCibilConsentOtp({ phone, otp }) {
  const mobile = normalizePhone(phone);
  const code = String(otp || '').trim();
  if (!/^[6-9]\d{9}$/.test(mobile)) {
    const e = new Error('Enter a valid 10-digit mobile number');
    e.status = 400;
    throw e;
  }
  if (!/^\d{4,8}$/.test(code)) {
    const e = new Error('Enter a valid OTP');
    e.status = 400;
    throw e;
  }

  const pool = getPool();
  const [[row]] = await pool.execute(
    `SELECT * FROM lead_otps
     WHERE phone = :phone
       AND purpose = :purpose
       AND verified_at IS NULL
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    { phone: mobile, purpose: PURPOSE },
  );

  if (!row || row.otp_hash !== hashOtp(code)) {
    const e = new Error('Invalid or expired OTP');
    e.status = 400;
    throw e;
  }

  await pool.execute(`UPDATE lead_otps SET verified_at = NOW() WHERE id = :id`, { id: row.id });

  const consentToken = crypto
    .createHmac('sha256', hmacSecret())
    .update(`${mobile}|${row.id}|cibil`)
    .digest('hex');

  // Persist token binding for short window (reuse otp row id as session).
  await pool.execute(
    `UPDATE lead_otps SET purpose = :purpose WHERE id = :id`,
    { id: row.id, purpose: `${PURPOSE}_ok` },
  );

  return {
    verified: true,
    phone: mobile,
    consentToken,
    otpId: row.id,
    consentLink: getCibilConsentLink(),
    expiresInSeconds: Math.floor(TOKEN_TTL_MS / 1000),
  };
}

export async function assertCibilConsentToken({ phone, consentToken, otpId }) {
  const mobile = normalizePhone(phone);
  if (!consentToken || !otpId) {
    const e = new Error('Customer OTP consent is required before generating CIBIL');
    e.status = 400;
    throw e;
  }
  const expected = crypto
    .createHmac('sha256', hmacSecret())
    .update(`${mobile}|${otpId}|cibil`)
    .digest('hex');
  if (expected !== String(consentToken)) {
    const e = new Error('Invalid CIBIL consent token. Please verify OTP again.');
    e.status = 400;
    throw e;
  }

  const pool = getPool();
  const [[row]] = await pool.execute(
    `SELECT id, verified_at, purpose, created_at
     FROM lead_otps WHERE id = :id AND phone = :phone LIMIT 1`,
    { id: otpId, phone: mobile },
  );
  if (!row?.verified_at || !String(row.purpose || '').startsWith(PURPOSE)) {
    const e = new Error('CIBIL consent OTP not verified');
    e.status = 400;
    throw e;
  }
  const ageMs = Date.now() - new Date(row.verified_at).getTime();
  if (ageMs > TOKEN_TTL_MS) {
    const e = new Error('CIBIL consent expired. Send OTP again.');
    e.status = 400;
    throw e;
  }
  return true;
}

/**
 * Homepage "Check free CIBIL score" — send mobile OTP (consent SMS) and email OTP when required.
 */
export async function requestHomepageCibilContactOtp({ phone, email }) {
  const mobile = normalizePhone(phone);
  const normalizedEmail = normalizeEmail(email);

  if (!/^[6-9]\d{9}$/.test(mobile)) {
    const e = new Error('Enter a valid 10-digit mobile number');
    e.status = 400;
    throw e;
  }
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    const e = new Error('Valid email is required');
    e.status = 400;
    throw e;
  }
  if (isSyntheticLeadEmail(normalizedEmail)) {
    const e = new Error('Enter a real email address to verify');
    e.status = 400;
    throw e;
  }

  const settings = await getOtpProviderSettings();
  const pool = getPool();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  const otpIds = {};
  // Homepage CIBIL always requires mobile verification (marketing SMS consent).
  let requireMobileOtp = true;
  // Email OTP when admin OTP settings require it (form always collects a real email).
  let requireEmailOtp = settings.requireEmailOtp !== false;

  // Cap resends: max 5 SMS OTPs per phone in 60 minutes for this purpose.
  const [[recent]] = await pool.execute(
    `SELECT COUNT(*)::int AS cnt FROM lead_otps
     WHERE phone = :phone
       AND purpose IN (:p1, :p2)
       AND channel = 'sms'
       AND created_at > NOW() - INTERVAL '60 minutes'`,
    { phone: mobile, p1: HOMEPAGE_PURPOSE, p2: `${HOMEPAGE_PURPOSE}_ok` },
  ).catch(() => [[{ cnt: 0 }]]);
  if (Number(recent?.cnt || 0) >= 5) {
    const e = new Error('Maximum OTP resend attempts reached. Please try again later.');
    e.status = 429;
    throw e;
  }

  if (requireMobileOtp) {
    const mobileOtp = generateOtp();
    const smsId = newId();
    await pool.execute(
      `INSERT INTO lead_otps (id, lead_id, email, phone, otp_hash, purpose, channel, expires_at)
       VALUES (:id, NULL, :email, :phone, :hash, :purpose, 'sms', :expires)`,
      {
        id: smsId,
        email: normalizedEmail,
        phone: mobile,
        hash: hashOtp(mobileOtp),
        purpose: HOMEPAGE_PURPOSE,
        expires: expiresAt.toISOString(),
      },
    );
    otpIds.sms = smsId;

    try {
      await sendCibilConsentOtpSms({ phone: mobile, otp: mobileOtp });
    } catch (err) {
      const e = new Error(toPublicOtpMessage(err?.message));
      e.status = err?.status || 502;
      throw e;
    }

    if (process.env.LOG_OTP === 'true' || process.env.NODE_ENV !== 'production') {
      console.log('[homepage-cibil-otp:sms]', {
        phone: `******${mobile.slice(-4)}`,
        otp: process.env.LOG_OTP === 'true' ? mobileOtp : '(hidden)',
      });
    }
  }

  if (requireEmailOtp) {
    const emailOtp = generateOtp();
    let emailDelivered = false;
    try {
      const emailResult = await sendOtpNotification({
        email: normalizedEmail,
        otp: emailOtp,
        channel: 'email',
        settings,
      });
      emailDelivered = !(emailResult?.sent === false && emailResult?.delivered === false);
    } catch (err) {
      console.warn('[homepage-cibil-otp:email]', err?.message || err);
      emailDelivered = false;
    }

    if (emailDelivered) {
      const emailId = newId();
      await pool.execute(
        `INSERT INTO lead_otps (id, lead_id, email, phone, otp_hash, purpose, channel, expires_at)
         VALUES (:id, NULL, :email, :phone, :hash, :purpose, 'email', :expires)`,
        {
          id: emailId,
          email: normalizedEmail,
          phone: mobile,
          hash: hashOtp(emailOtp),
          purpose: HOMEPAGE_PURPOSE,
          expires: expiresAt.toISOString(),
        },
      );
      otpIds.email = emailId;

      if (process.env.LOG_OTP === 'true' || process.env.NODE_ENV !== 'production') {
        console.log('[homepage-cibil-otp:email]', {
          email: normalizedEmail.replace(/(^.).*(@.*$)/, '$1***$2'),
          otp: process.env.LOG_OTP === 'true' ? emailOtp : '(hidden)',
        });
      }
    } else {
      // Soft-fail email: still allow mobile-only verify if SMS was issued.
      requireEmailOtp = false;
      console.warn('[homepage-cibil-otp:email] delivery failed, degrading to mobile-only');
    }
  }

  if (!requireMobileOtp && !requireEmailOtp) {
    const e = new Error(toPublicOtpMessage(null));
    e.status = 502;
    throw e;
  }

  return {
    sent: true,
    phone: mobile,
    email: normalizedEmail,
    expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
    requireMobileOtp,
    requireEmailOtp,
    consentLink: getCibilConsentLink(),
    otpIds,
  };
}

export async function verifyHomepageCibilContactOtp({
  phone,
  email,
  mobileOtp,
  emailOtp,
  otp,
}) {
  const mobile = normalizePhone(phone);
  const normalizedEmail = normalizeEmail(email);
  const mobileCode = String(mobileOtp || otp || '').trim();
  const emailCode = String(emailOtp || '').trim();

  if (!/^[6-9]\d{9}$/.test(mobile)) {
    const e = new Error('Enter a valid 10-digit mobile number');
    e.status = 400;
    throw e;
  }
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    const e = new Error('Valid email is required');
    e.status = 400;
    throw e;
  }

  const pool = getPool();

  const [[pendingSms]] = await pool.execute(
    `SELECT * FROM lead_otps
     WHERE phone = :phone
       AND purpose = :purpose
       AND channel = 'sms'
       AND verified_at IS NULL
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    { phone: mobile, purpose: HOMEPAGE_PURPOSE },
  );

  const [[pendingEmail]] = await pool.execute(
    `SELECT * FROM lead_otps
     WHERE email = :email
       AND phone = :phone
       AND purpose = :purpose
       AND channel = 'email'
       AND verified_at IS NULL
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    { email: normalizedEmail, phone: mobile, purpose: HOMEPAGE_PURPOSE },
  );

  const needMobile = Boolean(pendingSms);
  const needEmail = Boolean(pendingEmail);

  if (!needMobile && !needEmail) {
    const e = new Error('OTP has expired. Please request a new OTP.');
    e.status = 401;
    throw e;
  }

  if (needMobile && !/^\d{4,8}$/.test(mobileCode)) {
    const e = new Error('Enter the OTP sent to your mobile');
    e.status = 400;
    throw e;
  }
  if (needEmail && !/^\d{4,8}$/.test(emailCode)) {
    const e = new Error('Enter the OTP sent to your email');
    e.status = 400;
    throw e;
  }

  const devBypass =
    process.env.LOG_OTP === 'true'
    && (!needMobile || mobileCode === '123456')
    && (!needEmail || emailCode === '123456');

  if (needMobile && !devBypass && pendingSms.otp_hash !== hashOtp(mobileCode)) {
    const e = new Error('Invalid or expired mobile OTP');
    e.status = 400;
    throw e;
  }
  if (needEmail && !devBypass && pendingEmail.otp_hash !== hashOtp(emailCode)) {
    const e = new Error('Invalid or expired email OTP');
    e.status = 400;
    throw e;
  }

  const smsOtpId = needMobile ? pendingSms.id : null;
  const emailOtpId = needEmail ? pendingEmail.id : null;

  if (smsOtpId) {
    await pool.execute(
      `UPDATE lead_otps SET verified_at = NOW(), purpose = :purpose WHERE id = :id`,
      { id: smsOtpId, purpose: `${HOMEPAGE_PURPOSE}_ok` },
    );
  }
  if (emailOtpId) {
    await pool.execute(
      `UPDATE lead_otps SET verified_at = NOW(), purpose = :purpose WHERE id = :id`,
      { id: emailOtpId, purpose: `${HOMEPAGE_PURPOSE}_ok` },
    );
  }

  const consentToken = buildHomepageContactToken({
    phone: mobile,
    email: normalizedEmail,
    smsOtpId,
    emailOtpId,
  });

  return {
    verified: true,
    phone: mobile,
    email: normalizedEmail,
    phoneVerified: needMobile,
    emailVerified: needEmail,
    consentToken,
    otpId: smsOtpId || emailOtpId,
    emailOtpId,
    consentLink: getCibilConsentLink(),
    expiresInSeconds: Math.floor(TOKEN_TTL_MS / 1000),
  };
}

export async function assertHomepageCibilContactToken({
  phone,
  email,
  consentToken,
  otpId,
  emailOtpId,
}) {
  const mobile = normalizePhone(phone);
  const normalizedEmail = normalizeEmail(email);

  if (!consentToken || (!otpId && !emailOtpId)) {
    const e = new Error('Verify your mobile and email with OTP before fetching your CIBIL score');
    e.status = 400;
    throw e;
  }

  const expected = buildHomepageContactToken({
    phone: mobile,
    email: normalizedEmail,
    smsOtpId: otpId || null,
    emailOtpId: emailOtpId || null,
  });
  if (expected !== String(consentToken)) {
    const e = new Error('Contact verification expired or invalid. Please verify OTP again.');
    e.status = 400;
    throw e;
  }

  const pool = getPool();
  const checks = [];

  if (otpId) {
    const [[row]] = await pool.execute(
      `SELECT id, verified_at, purpose, phone, channel
       FROM lead_otps WHERE id = :id LIMIT 1`,
      { id: otpId },
    );
    if (
      !row?.verified_at
      || normalizePhone(row.phone) !== mobile
      || !String(row.purpose || '').startsWith(HOMEPAGE_PURPOSE)
    ) {
      const e = new Error('Mobile OTP not verified');
      e.status = 400;
      throw e;
    }
    if (Date.now() - new Date(row.verified_at).getTime() > TOKEN_TTL_MS) {
      const e = new Error('Contact verification expired. Send OTP again.');
      e.status = 400;
      throw e;
    }
    checks.push({ channel: 'sms', verified: true });
  }

  if (emailOtpId) {
    const [[row]] = await pool.execute(
      `SELECT id, verified_at, purpose, email, phone, channel
       FROM lead_otps WHERE id = :id LIMIT 1`,
      { id: emailOtpId },
    );
    if (
      !row?.verified_at
      || normalizeEmail(row.email) !== normalizedEmail
      || normalizePhone(row.phone) !== mobile
      || !String(row.purpose || '').startsWith(HOMEPAGE_PURPOSE)
    ) {
      const e = new Error('Email OTP not verified');
      e.status = 400;
      throw e;
    }
    if (Date.now() - new Date(row.verified_at).getTime() > TOKEN_TTL_MS) {
      const e = new Error('Contact verification expired. Send OTP again.');
      e.status = 400;
      throw e;
    }
    checks.push({ channel: 'email', verified: true });
  }

  // Mobile is always required for homepage CIBIL when an sms otpId is expected.
  if (!otpId && !emailOtpId) {
    const e = new Error('Contact verification required');
    e.status = 400;
    throw e;
  }

  return {
    phoneVerified: checks.some((c) => c.channel === 'sms'),
    emailVerified: checks.some((c) => c.channel === 'email'),
  };
}
