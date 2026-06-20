/**
 * MSG91 SMS / OTP / WhatsApp integration.
 * @see https://docs.msg91.com/otp
 *
 * Server env:
 *   MSG91_AUTH_KEY (required)
 *   MSG91_SENDER_ID (6-char DLT sender)
 *   MSG91_OTP_TEMPLATE_ID or MSG91_TEMPLATE_ID (OTP template in MSG91 panel)
 *   MSG91_FLOW_TEMPLATE_ID (optional Flow API template)
 *   MSG91_WHATSAPP_TEMPLATE_ID (optional)
 *   MSG91_ROUTE (default 4 = transactional India)
 */

import { fetchWithTimeout } from './fetchWithTimeout.js';

const MSG91_OTP_URL = 'https://control.msg91.com/api/v5/otp';
const MSG91_FLOW_URL = 'https://control.msg91.com/api/v5/flow/';
const MSG91_SMS_HTTP_URL = 'https://control.msg91.com/api/sendhttp.php';
const MSG91_WHATSAPP_URL =
  'https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/';

const MSG91_FETCH_TIMEOUT_MS = Number(process.env.MSG91_FETCH_TIMEOUT_MS || 15000);

export function normalizeIndianMobile(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits.slice(-10);
}

export function getMsg91Config(overrides = {}) {
  const templateId =
    overrides.msg91OtpTemplateId ||
    overrides.msg91TemplateId ||
    process.env.MSG91_OTP_TEMPLATE_ID ||
    process.env.MSG91_TEMPLATE_ID ||
    '';

  return {
    authKey: (process.env.MSG91_AUTH_KEY || '').trim(),
    senderId:
      overrides.msg91SenderId || process.env.MSG91_SENDER_ID || 'RFINCR',
    otpTemplateId: templateId,
    flowTemplateId:
      overrides.msg91FlowTemplateId ||
      process.env.MSG91_FLOW_TEMPLATE_ID ||
      '',
    whatsappTemplateId:
      overrides.msg91WhatsappTemplateId ||
      process.env.MSG91_WHATSAPP_TEMPLATE_ID ||
      '',
    route: process.env.MSG91_ROUTE || '4',
    countryCode: '91',
  };
}

export function isMsg91Configured() {
  return Boolean(getMsg91Config().authKey);
}

function requireAuthKey(config) {
  if (!config.authKey) {
    const err = new Error(
      'MSG91 is not configured. Set MSG91_AUTH_KEY in the server environment (Render/hosting dashboard), then redeploy the API.',
    );
    err.status = 503;
    throw err;
  }
}

async function parseMsg91Response(res) {
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  const failed =
    !res.ok ||
    data?.type === 'error' ||
    (typeof data?.message === 'string' && /error|fail/i.test(data.message));

  if (failed) {
    const detail =
      data?.message ||
      data?.msg ||
      (Array.isArray(data?.errors) ? data.errors.join('; ') : null) ||
      text ||
      `HTTP ${res.status}`;
    const err = new Error(`MSG91: ${String(detail).slice(0, 400)}`);
    err.status = res.status >= 400 && res.status < 500 ? res.status : 502;
    throw err;
  }

  return data;
}

/**
 * Send OTP via MSG91 v5 OTP API (DLT-approved OTP template).
 */
export async function sendMsg91Otp({ phone, otp, config: overrides = {} }) {
  const config = getMsg91Config(overrides);
  requireAuthKey(config);

  const mobile = normalizeIndianMobile(phone);
  if (mobile.length !== 10) {
    throw new Error('Invalid Indian mobile number (10 digits required).');
  }

  if (!config.otpTemplateId) {
    return sendMsg91TransactionalSms({
      phone: mobile,
      message: null,
      otp,
      config: overrides,
    });
  }

  const mobileE164 = `${config.countryCode}${mobile}`;
  const url = `${MSG91_OTP_URL}?otp_expiry=10&otp_length=6`;

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        authkey: config.authKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        template_id: config.otpTemplateId,
        mobile: mobileE164,
        otp: String(otp),
      }),
      timeoutMessage:
        'MSG91 OTP request timed out. Verify MSG91_AUTH_KEY, MSG91_OTP_TEMPLATE_ID, and server outbound network access.',
    },
    MSG91_FETCH_TIMEOUT_MS,
  );

  await parseMsg91Response(res);
  return { sent: true, provider: 'msg91', mode: 'otp_api', mobile: mobileE164 };
}

/**
 * MSG91 Flow API (template variables).
 */
export async function sendMsg91Flow({ phone, variables = {}, config: overrides = {} }) {
  const config = getMsg91Config(overrides);
  requireAuthKey(config);

  const templateId = config.flowTemplateId || config.otpTemplateId;
  if (!templateId) {
    throw new Error('MSG91 flow template ID is not configured.');
  }

  const mobile = normalizeIndianMobile(phone);
  const res = await fetchWithTimeout(
    MSG91_FLOW_URL,
    {
      method: 'POST',
      headers: {
        authkey: config.authKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        template_id: templateId,
        short_url: '0',
        recipients: [{ mobiles: `${config.countryCode}${mobile}`, ...variables }],
      }),
      timeoutMessage: 'MSG91 Flow request timed out.',
    },
    MSG91_FETCH_TIMEOUT_MS,
  );

  await parseMsg91Response(res);
  return { sent: true, provider: 'msg91', mode: 'flow' };
}

/**
 * Legacy transactional SMS (when no OTP template ID).
 */
export async function sendMsg91TransactionalSms({
  phone,
  message,
  otp,
  config: overrides = {},
  messageTemplate,
}) {
  const config = getMsg91Config(overrides);
  requireAuthKey(config);

  const mobile = normalizeIndianMobile(phone);
  const tpl =
    messageTemplate ||
    'Your Rfincare verification code is {{otp}}. Valid for 10 minutes.';
  const body = message || tpl.replace(/\{\{otp\}\}/g, String(otp));

  const url = new URL(MSG91_SMS_HTTP_URL);
  url.searchParams.set('authkey', config.authKey);
  url.searchParams.set('mobiles', `${config.countryCode}${mobile}`);
  url.searchParams.set('message', body);
  url.searchParams.set('sender', config.senderId);
  url.searchParams.set('route', config.route);
  url.searchParams.set('country', config.countryCode);

  const res = await fetchWithTimeout(
    url.toString(),
    {
      timeoutMessage: 'MSG91 SMS request timed out.',
    },
    MSG91_FETCH_TIMEOUT_MS,
  );
  const text = await res.text();
  if (!res.ok || /invalid|error|authentication|denied/i.test(text)) {
    throw new Error(`MSG91 SMS failed: ${text.slice(0, 300)}`);
  }

  return { sent: true, provider: 'msg91', mode: 'transactional_sms', requestId: text.trim() };
}

/**
 * WhatsApp outbound (requires MSG91 WhatsApp template + namespace in panel).
 */
export async function sendMsg91Whatsapp({ phone, otp, config: overrides = {} }) {
  const config = getMsg91Config(overrides);
  requireAuthKey(config);

  if (!config.whatsappTemplateId) {
    return sendMsg91Otp({ phone, otp, config: overrides });
  }

  const mobile = normalizeIndianMobile(phone);
  const res = await fetchWithTimeout(
    MSG91_WHATSAPP_URL,
    {
      method: 'POST',
      headers: {
        authkey: config.authKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        integrated_number: process.env.MSG91_WHATSAPP_INTEGRATED_NUMBER || '',
        template_name: config.whatsappTemplateId,
        language: process.env.MSG91_WHATSAPP_LANGUAGE || 'en',
        recipients: [
          {
            mobiles: [`${config.countryCode}${mobile}`],
            variables: { otp: String(otp), OTP: String(otp) },
          },
        ],
      }),
      timeoutMessage: 'MSG91 WhatsApp request timed out.',
    },
    MSG91_FETCH_TIMEOUT_MS,
  );

  await parseMsg91Response(res);
  return { sent: true, provider: 'msg91', mode: 'whatsapp' };
}

/** Non-destructive connectivity check for admin UI. */
export async function testMsg91Connection(overrides = {}) {
  const config = getMsg91Config(overrides);
  if (!config.authKey) {
    return { ok: false, error: 'MSG91_AUTH_KEY is missing on the server.' };
  }
  return {
    ok: true,
    senderId: config.senderId,
    otpTemplateId: config.otpTemplateId || '(using plain SMS — set MSG91_OTP_TEMPLATE_ID)',
    flowTemplateId: config.flowTemplateId || null,
    whatsappTemplateId: config.whatsappTemplateId || null,
  };
}
