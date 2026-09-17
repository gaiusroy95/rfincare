import crypto from 'crypto';

import { getPool } from '../db/pool.js';
import { newId } from './ids.js';
import { generateOtp, getOtpProviderSettings, sendOtpNotification } from './otp.js';
import { sendMsg91Flow, sendMsg91TransactionalSms, getMsg91Config } from './msg91.js';

const PURPOSE = 'call_consent';
const OTP_TTL_MS = 10 * 60 * 1000;
const TERMS_SLUG = 'terms-of-service';
const PRIVACY_SLUG = 'privacy-policy';

function hashOtp(otp) {
  return crypto.createHash('sha256').update(String(otp)).digest('hex');
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function publicAppBase() {
  return String(
    process.env.PUBLIC_APP_URL
      || process.env.FRONTEND_URL
      || process.env.PUBLIC_FRONTEND_URL
      || 'https://rfincare.com',
  ).replace(/\/$/, '');
}

export function getCallConsentTermsLink() {
  return `${publicAppBase()}/legal/${TERMS_SLUG}`;
}

export function getCallConsentPrivacyLink() {
  return `${publicAppBase()}/legal/${PRIVACY_SLUG}`;
}

function buildConsentOtpMessage(otp, termsLink) {
  const tpl =
    process.env.MSG91_CALL_CONSENT_SMS_TEMPLATE
    || 'Rfincare OTP {{otp}} to consent to a call about your enquiry. Terms: {{termsLink}}. Valid 10 min. -RFINCR';
  return String(tpl)
    .replace(/\{\{otp\}\}/gi, String(otp))
    .replace(/\{\{termsLink\}\}/gi, termsLink)
    .replace(/\{\{terms_link\}\}/gi, termsLink)
    .replace(/\{\{consentLink\}\}/gi, termsLink)
    .replace(/\{\{consent_link\}\}/gi, termsLink)
    .replace(/\{\{CONSENT_LINK\}\}/g, termsLink);
}

/**
 * Send call-consent OTP via MSG91 (message includes Terms link) or configured OTP providers.
 */
export async function sendCallConsentOtpSms({ phone, otp }) {
  const settings = await getOtpProviderSettings();
  const termsLink = getCallConsentTermsLink();
  const privacyLink = getCallConsentPrivacyLink();
  const message = buildConsentOtpMessage(otp, termsLink);
  const mobile = normalizePhone(phone);

  const cfg = settings.providerConfig || {};
  const flowId =
    process.env.MSG91_CALL_CONSENT_FLOW_ID
    || cfg.msg91CallConsentFlowId
    || cfg.msg91_call_consent_flow_id
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
            TERMS_LINK: termsLink,
            terms_link: termsLink,
            termsLink,
            PRIVACY_LINK: privacyLink,
            privacy_link: privacyLink,
            privacyLink,
            CONSENT_LINK: termsLink,
            consent_link: termsLink,
            consentLink: termsLink,
          },
          config: {
            ...cfg,
            msg91FlowTemplateId: flowId,
          },
        });
        return {
          sent: true,
          provider: 'msg91',
          mode: 'call_consent_flow',
          termsLink,
          privacyLink,
        };
      } catch (err) {
        console.warn('[call-consent-otp] flow failed, falling back to SMS:', err?.message);
      }
    }

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
        mode: 'call_consent_sms',
        termsLink,
        privacyLink,
      };
    } catch (err) {
      console.warn('[call-consent-otp] transactional SMS failed, falling back to OTP channel:', err?.message);
    }
  }

  const result = await sendOtpNotification({
    phone: mobile,
    otp,
    channel: 'sms',
    settings,
  });
  return {
    ...result,
    termsLink,
    privacyLink,
    mode: result?.mode || 'otp_channel',
  };
}

export async function requestCallConsentOtp({ phone, initiatedByUserId = null }) {
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

  const sendResult = await sendCallConsentOtpSms({ phone: mobile, otp });

  if (process.env.LOG_OTP === 'true' || process.env.NODE_ENV !== 'production') {
    console.log('[call-consent-otp]', {
      phone: `******${mobile.slice(-4)}`,
      termsLink: sendResult.termsLink,
      initiatedByUserId,
      otp: process.env.LOG_OTP === 'true' ? otp : '(hidden)',
    });
  }

  return {
    sent: true,
    phone: mobile,
    expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
    termsLink: sendResult.termsLink || getCallConsentTermsLink(),
    privacyLink: sendResult.privacyLink || getCallConsentPrivacyLink(),
    delivery: {
      provider: sendResult.provider || null,
      mode: sendResult.mode || null,
    },
  };
}

export async function verifyCallConsentOtp({ phone, otp }) {
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
    .createHmac('sha256', process.env.JWT_ACCESS_SECRET || 'rfincare-call-consent')
    .update(`${mobile}|${row.id}|call`)
    .digest('hex');

  await pool.execute(
    `UPDATE lead_otps SET purpose = :purpose WHERE id = :id`,
    { id: row.id, purpose: `${PURPOSE}_ok` },
  );

  return {
    verified: true,
    phone: mobile,
    consentToken,
    otpId: row.id,
    termsLink: getCallConsentTermsLink(),
    privacyLink: getCallConsentPrivacyLink(),
    expiresInSeconds: 15 * 60,
  };
}

export async function assertCallConsentToken({ phone, consentToken, otpId }) {
  const mobile = normalizePhone(phone);
  if (!consentToken || !otpId) {
    const e = new Error('Customer OTP consent to call is required before creating the lead');
    e.status = 400;
    throw e;
  }
  const expected = crypto
    .createHmac('sha256', process.env.JWT_ACCESS_SECRET || 'rfincare-call-consent')
    .update(`${mobile}|${otpId}|call`)
    .digest('hex');
  if (expected !== String(consentToken)) {
    const e = new Error('Invalid call-consent token. Please verify OTP again.');
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
    const e = new Error('Call-consent OTP not verified');
    e.status = 400;
    throw e;
  }
  const ageMs = Date.now() - new Date(row.verified_at).getTime();
  if (ageMs > 15 * 60 * 1000) {
    const e = new Error('Call consent expired. Send OTP again.');
    e.status = 400;
    throw e;
  }
  return true;
}
