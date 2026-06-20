import crypto from 'node:crypto';

import { withPromiseTimeout } from './fetchWithTimeout.js';
import { sendEmail, smtpConfigured } from './email.js';
import {
  getMsg91Config,
  isMsg91Configured,
  sendMsg91Otp,
  sendMsg91Whatsapp,
} from './msg91.js';
import { getOtpProviderSettings } from './otpProviderSettings.js';

export function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function hashOtp(otp) {
  return crypto.createHash('sha256').update(String(otp)).digest('hex');
}

function maskPhone(phone) {
  if (!phone) return null;
  const p = String(phone);
  return `***${p.slice(-4)}`;
}

function formatOtpMessage(template, otp) {
  const tpl =
    template || 'Your Rfincare verification code is {{otp}}. Valid for 10 minutes.';
  return tpl.replace(/\{\{otp\}\}/g, otp);
}

/** Readiness flags for admin (no secrets). */
export function getOtpInfrastructureStatus() {
  return {
    msg91: {
      configured: isMsg91Configured(),
      senderId: process.env.MSG91_SENDER_ID || null,
      otpTemplateId:
        process.env.MSG91_OTP_TEMPLATE_ID || process.env.MSG91_TEMPLATE_ID || null,
      whatsappTemplateId: process.env.MSG91_WHATSAPP_TEMPLATE_ID || null,
    },
    twilio: {
      configured: Boolean(
        process.env.TWILIO_ACCOUNT_SID &&
          process.env.TWILIO_AUTH_TOKEN &&
          process.env.TWILIO_PHONE_NUMBER,
      ),
    },
    smtp: { configured: smtpConfigured() },
    logOtp: process.env.LOG_OTP === 'true',
  };
}

async function sendViaTwilio({ phone, message }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) {
    throw new Error(
      'Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER.',
    );
  }

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const body = new URLSearchParams({
    To: phone.startsWith('+') ? phone : `+91${phone.replace(/\D/g, '').slice(-10)}`,
    From: from,
    Body: message,
  });

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Twilio SMS failed: ${errText.slice(0, 200)}`);
  }
  return { sent: true, provider: 'twilio' };
}

async function sendViaTwilioWhatsapp({ phone, message }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_NUMBER || process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) {
    throw new Error(
      'Twilio WhatsApp is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER.',
    );
  }

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const clean = phone.replace(/\D/g, '').slice(-10);
  const to = `whatsapp:+91${clean}`;
  const fromValue = from.startsWith('whatsapp:') ? from : `whatsapp:${from}`;
  const body = new URLSearchParams({
    To: to,
    From: fromValue,
    Body: message,
  });

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Twilio WhatsApp failed: ${errText.slice(0, 200)}`);
  }
  return { sent: true, provider: 'twilio' };
}

async function sendViaMsg91({ phone, otp, config }) {
  const providerConfig = config || {};
  return sendMsg91Otp({
    phone,
    otp,
    config: {
      msg91SenderId: providerConfig.msg91SenderId,
      msg91OtpTemplateId:
        providerConfig.msg91OtpTemplateId || providerConfig.msg91TemplateId,
      msg91FlowTemplateId: providerConfig.msg91FlowTemplateId,
      msg91WhatsappTemplateId: providerConfig.msg91WhatsappTemplateId,
    },
  });
}

async function sendSmsOtp({ phone, otp, settings }) {
  const provider = settings?.smsProvider || 'console';
  const message = formatOtpMessage(settings?.providerConfig?.otpMessageTemplate, otp);

  if (provider === 'console') {
    console.log(
      '[otp:sms]',
      { phone: maskPhone(phone), provider },
      process.env.LOG_OTP === 'true' ? otp : '(hidden)',
    );
    return { sent: true, provider: 'console' };
  }

  if (provider === 'twilio') {
    return sendViaTwilio({ phone, message });
  }

  if (provider === 'msg91') {
    if (!isMsg91Configured()) {
      const err = new Error(
        'SMS operator is MSG91 but MSG91_AUTH_KEY is not set on the server. Add it in hosting env vars or switch SMS operator to Console in Admin → OTP settings.',
      );
      err.status = 503;
      throw err;
    }
    return sendViaMsg91({ phone, otp, config: settings?.providerConfig });
  }

  throw new Error(`Unknown SMS provider: ${provider}`);
}

async function sendEmailOtp({ email, otp, settings }) {
  const provider = settings?.emailProvider || 'console';
  const subject = 'Your Rfincare verification code';
  const text = formatOtpMessage(settings?.providerConfig?.otpMessageTemplate, otp);
  const html = `<p>${text}</p><p>If you did not request this, please ignore this email.</p>`;

  if (provider === 'console') {
    console.log(
      '[otp:email]',
      { email, provider },
      process.env.LOG_OTP === 'true' ? otp : '(hidden)',
    );
    return { sent: true, provider: 'console' };
  }

  if (provider === 'smtp') {
    if (!smtpConfigured()) {
      const err = new Error(
        'Email operator is SMTP but SMTP_HOST/SMTP_FROM are not set on the server. Configure SMTP or set email operator to Console in Admin → OTP settings.',
      );
      err.status = 503;
      throw err;
    }
    const result = await sendEmail({ to: email, subject, text, html });
    if (!result.sent) {
      const err = new Error(result.warning || 'Email OTP could not be delivered.');
      err.status = 502;
      throw err;
    }
    return { ...result, provider: 'smtp' };
  }

  throw new Error(`Unknown email provider: ${provider}`);
}

async function sendWhatsappOtp({ phone, otp, settings }) {
  const provider = settings?.whatsappProvider || 'console';
  const message = formatOtpMessage(settings?.providerConfig?.otpMessageTemplate, otp);

  if (provider === 'console') {
    console.log(
      '[otp:whatsapp]',
      { phone: maskPhone(phone), provider },
      process.env.LOG_OTP === 'true' ? otp : '(hidden)',
    );
    return { sent: true, provider: 'console' };
  }
  if (provider === 'twilio') {
    return sendViaTwilioWhatsapp({ phone, message });
  }
  if (provider === 'msg91') {
    if (!isMsg91Configured()) {
      const err = new Error(
        'WhatsApp operator is MSG91 but MSG91_AUTH_KEY is not set on the server.',
      );
      err.status = 503;
      throw err;
    }
    return sendMsg91Whatsapp({ phone, otp, config: settings?.providerConfig });
  }
  throw new Error(`Unknown WhatsApp provider: ${provider}`);
}

const CHANNEL_TIMEOUT_MS = Number(process.env.OTP_CHANNEL_TIMEOUT_MS || 20000);

function channelTimeout(promise, label) {
  return withPromiseTimeout(
    promise,
    CHANNEL_TIMEOUT_MS,
    `${label} timed out after ${Math.round(CHANNEL_TIMEOUT_MS / 1000)}s. Check server OTP/SMTP/MSG91 configuration.`,
  );
}

function aggregateChannelErrors(results) {
  const failures = results
    .filter((r) => r.status === 'rejected')
    .map((r) => r.reason?.message || 'Send failed');
  if (!failures.length) return null;
  return failures.join('; ');
}

/**
 * Send OTP via configured operators. `channel` may be sms | email | whatsapp | both.
 */
export async function sendOtpNotification({
  email,
  phone,
  otp,
  channel,
  settings: settingsOverride,
}) {
  const settings = settingsOverride || (await getOtpProviderSettings());
  const tasks = [];
  const labels = [];

  const wantSms =
    channel === 'sms' ||
    channel === 'both' ||
    (!channel && settings.requireMobileOtp);
  const wantEmail =
    channel === 'email' ||
    channel === 'both' ||
    (!channel && settings.requireEmailOtp);
  const wantWhatsapp =
    channel === 'whatsapp' ||
    channel === 'both' ||
    (!channel && settings.requireWhatsappOtp);

  if (wantSms && phone) {
    tasks.push(channelTimeout(sendSmsOtp({ phone, otp, settings }), 'SMS OTP'));
    labels.push('sms');
  }
  if (wantEmail && email) {
    tasks.push(channelTimeout(sendEmailOtp({ email, otp, settings }), 'Email OTP'));
    labels.push('email');
  }
  if (wantWhatsapp && phone) {
    tasks.push(channelTimeout(sendWhatsappOtp({ phone, otp, settings }), 'WhatsApp OTP'));
    labels.push('whatsapp');
  }

  if (!tasks.length) {
    console.log(
      '[otp]',
      { email, phone: maskPhone(phone), channel },
      process.env.LOG_OTP === 'true' ? otp : '(hidden)',
    );
    return { sent: true, channels: [] };
  }

  const results = await Promise.allSettled(tasks);
  const errMsg = aggregateChannelErrors(results);
  if (errMsg) {
    const err = new Error(errMsg);
    err.status = results.find((r) => r.reason?.status)?.reason?.status || 502;
    throw err;
  }

  const out = { sent: true, channels: labels };
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') out[labels[i]] = r.value;
  });
  return out;
}

/**
 * Send separate OTP codes for mobile and email (eligibility / lead verification).
 */
export async function sendDualChannelOtp({ email, phone, settings: settingsOverride }) {
  const settings = settingsOverride || (await getOtpProviderSettings());
  const mobileOtp = generateOtp();
  const emailOtp = generateOtp();
  const warnings = [];
  const outcomes = {};

  async function runSmsChannel() {
    try {
      return await channelTimeout(
        sendSmsOtp({ phone, otp: mobileOtp, settings }),
        'SMS OTP',
      );
    } catch (err) {
      const errMsg = err?.message || 'SMS send failed';
      const hint =
        settings.smsProvider === 'msg91'
          ? `${errMsg} Confirm MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID on the server, and that the template is DLT-approved.`
          : errMsg;
      const e = new Error(hint);
      e.status = err?.status || 502;
      throw e;
    }
  }

  async function runEmailChannel() {
    try {
      return await channelTimeout(
        sendEmailOtp({ email, otp: emailOtp, settings }),
        'Email OTP',
      );
    } catch (err) {
      if (settings.emailProvider === 'smtp' && !smtpConfigured()) {
        warnings.push(
          'SMTP is not configured on the server; email OTP was logged server-side only. Set SMTP_* env vars or use Admin → OTP settings → Email operator: Console for testing.',
        );
        return sendEmailOtp({
          email,
          otp: emailOtp,
          settings: { ...settings, emailProvider: 'console' },
        });
      }
      const e = new Error(
        `${err?.message || 'Email OTP failed'}. Configure SMTP on the server or set email operator to Console in Admin → OTP settings.`,
      );
      e.status = err?.status || 502;
      throw e;
    }
  }

  const parallel = [];

  if (settings.requireMobileOtp !== false && phone) {
    parallel.push(
      runSmsChannel().then((r) => {
        outcomes.sms = r;
      }),
    );
  }

  if (settings.requireEmailOtp !== false && email) {
    parallel.push(
      runEmailChannel().then((r) => {
        outcomes.email = r;
        if (r?.sent === false && settings.emailProvider === 'smtp') {
          warnings.push(
            r.warning ||
              'Email was not delivered — configure SMTP_HOST and SMTP_FROM on the server.',
          );
        }
      }),
    );
  }

  await Promise.all(parallel);

  if (settings.requireWhatsappOtp && phone) {
    try {
      outcomes.whatsapp = await channelTimeout(
        sendWhatsappOtp({ phone, otp: mobileOtp, settings }),
        'WhatsApp OTP',
      );
    } catch (err) {
      warnings.push(err?.message || 'WhatsApp OTP failed');
    }
  }

  return {
    mobileOtp: settings.requireMobileOtp !== false ? mobileOtp : null,
    emailOtp: settings.requireEmailOtp !== false ? emailOtp : null,
    smsProvider: settings.smsProvider,
    emailProvider: settings.emailProvider,
    whatsappProvider: settings.whatsappProvider,
    msg91Configured: isMsg91Configured(),
    warnings,
    delivery: outcomes,
  };
}

