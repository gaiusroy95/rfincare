import crypto from 'crypto';

import { getPool } from '../db/pool.js';
import { newId } from './ids.js';
import { generateOtp, getOtpProviderSettings, sendOtpNotification } from './otp.js';
import { sendMsg91Flow, sendMsg91TransactionalSms, getMsg91Config } from './msg91.js';

const PURPOSE = 'cibil_consent';
const OTP_TTL_MS = 10 * 60 * 1000;
const CONSENT_SLUG = 'consent-data-collection-credit-bureau';

function hashOtp(otp) {
  return crypto.createHash('sha256').update(String(otp)).digest('hex');
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
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
    .createHmac('sha256', process.env.JWT_ACCESS_SECRET || 'rfincare-cibil-consent')
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
    expiresInSeconds: 15 * 60,
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
    .createHmac('sha256', process.env.JWT_ACCESS_SECRET || 'rfincare-cibil-consent')
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
  if (ageMs > 15 * 60 * 1000) {
    const e = new Error('CIBIL consent expired. Send OTP again.');
    e.status = 400;
    throw e;
  }
  return true;
}
