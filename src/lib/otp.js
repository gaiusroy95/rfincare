import crypto from 'node:crypto';

import { withPromiseTimeout } from './fetchWithTimeout.js';
import { sendEmail, smtpConfigured } from './email.js';
import {
  getMsg91Config,
  isMsg91Configured,
  isMsg91EmailConfigured,
  isMsg91WhatsappConfigured,
  sendMsg91EmailOtp,
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

/** Readiness flags for admin (no secrets). Merges DB providerConfig with env. */
export function getOtpInfrastructureStatus(providerConfig = {}) {
  const cfg = providerConfig || {};
  const msg91 = getMsg91Config(cfg);
  return {
    msg91: {
      configured: isMsg91Configured(),
      emailConfigured: isMsg91EmailConfigured(cfg),
      whatsappConfigured: isMsg91WhatsappConfigured(cfg),
      senderId: msg91.senderId || null,
      senderIdWarning: msg91.senderIdWarning || null,
      otpTemplateId: msg91.otpTemplateId || null,
      whatsappTemplateId: msg91.whatsappTemplateId || null,
      whatsappNamespace: msg91.whatsappNamespace || null,
      whatsappIntegratedNumber: msg91.whatsappIntegratedNumber || null,
      emailDomain: cfg.msg91EmailDomain || process.env.MSG91_EMAIL_DOMAIN || null,
      emailFrom:
        cfg.msg91EmailFromEmail
        || process.env.MSG91_EMAIL_FROM_EMAIL
        || process.env.MSG91_EMAIL_FROM
        || null,
      emailOtpTemplateId:
        cfg.msg91EmailOtpTemplateId || process.env.MSG91_EMAIL_OTP_TEMPLATE_ID || null,
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
      msg91WhatsappNamespace: providerConfig.msg91WhatsappNamespace,
      msg91WhatsappIntegratedNumber: providerConfig.msg91WhatsappIntegratedNumber,
      msg91WhatsappLanguage: providerConfig.msg91WhatsappLanguage,
      msg91WhatsappIncludeButton: providerConfig.msg91WhatsappIncludeButton,
    },
    messageTemplate: providerConfig.otpMessageTemplate,
  });
}

async function sendViaMsg91Email({ email, otp, recipientName, config }) {
  const providerConfig = config || {};
  return sendMsg91EmailOtp({
    email,
    otp,
    recipientName,
    config: {
      msg91EmailDomain: providerConfig.msg91EmailDomain,
      msg91EmailFromEmail: providerConfig.msg91EmailFromEmail,
      msg91EmailFromName: providerConfig.msg91EmailFromName,
      msg91EmailOtpTemplateId: providerConfig.msg91EmailOtpTemplateId,
      msg91EmailOtpVariable: providerConfig.msg91EmailOtpVariable,
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
    return {
      sent: false,
      provider: 'console',
      delivered: false,
      warning:
        'SMS operator is set to Console, so no SMS was actually sent. Set SMS operator to MSG91 or Twilio in Admin → OTP settings (and configure server env vars) to deliver OTP SMS.',
    };
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
    return {
      sent: true,
      provider: 'console',
      delivered: false,
      warning:
        'Email operator is set to Console, so no email was actually sent. Set the email operator to SMTP or MSG91 in Admin → OTP settings (and configure the server credentials) to deliver OTP emails.',
    };
  }

  if (provider === 'smtp') {
    if (!smtpConfigured()) {
      const err = new Error(
        'Email operator is SMTP but SMTP_HOST/SMTP_FROM are not set on the server. Configure SMTP or set email operator to MSG91 in Admin → OTP settings.',
      );
      err.status = 503;
      throw err;
    }
    const result = await sendEmail({ to: email, subject, text, html });
    if (!result.sent) {
      return { ...result, provider: 'smtp', delivered: false };
    }
    return { ...result, provider: 'smtp', delivered: true };
  }

  if (provider === 'msg91') {
    if (!isMsg91EmailConfigured(settings?.providerConfig)) {
      const err = new Error(
        'Email operator is MSG91 but MSG91 email is not configured. Set MSG91_AUTH_KEY, MSG91_EMAIL_DOMAIN, MSG91_EMAIL_FROM_EMAIL, and MSG91_EMAIL_OTP_TEMPLATE_ID on the server.',
      );
      err.status = 503;
      throw err;
    }
    const result = await sendViaMsg91Email({
      email,
      otp,
      config: settings?.providerConfig,
    });
    return { ...result, delivered: true };
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
    return {
      sent: false,
      provider: 'console',
      delivered: false,
      warning:
        'WhatsApp operator is set to Console, so no WhatsApp message was sent. Set WhatsApp operator to MSG91 in Admin → OTP settings.',
    };
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
    if (!isMsg91WhatsappConfigured(settings?.providerConfig)) {
      const err = new Error(
        'WhatsApp operator is MSG91 but template name, namespace, or integrated number is incomplete. Fill them in Admin → OTP settings and Save.',
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
  // When Require WhatsApp OTP is on, also fan out WhatsApp for SMS/mobile OTP flows
  // (application submit, agent/employee profile, etc.) — not only channel=whatsapp.
  const wantWhatsapp =
    channel === 'whatsapp' ||
    channel === 'both' ||
    (!channel && settings.requireWhatsappOtp) ||
    (Boolean(settings.requireWhatsappOtp) && Boolean(phone) && channel !== 'email');

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
    const missing = [];
    if ((channel === 'sms' || channel === 'whatsapp' || channel === 'both') && !phone) {
      missing.push('mobile number');
    }
    if ((channel === 'email' || channel === 'both') && !email) {
      missing.push('email');
    }
    if (missing.length) {
      const err = new Error(`Cannot send OTP: missing ${missing.join(' and ')}.`);
      err.status = 400;
      throw err;
    }
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
      const result = await channelTimeout(
        sendSmsOtp({ phone, otp: mobileOtp, settings }),
        'SMS OTP',
      );
      if (result?.warning) warnings.push(result.warning);
      if (result?.sent === false && result?.delivered === false) {
        warnings.push(result.warning || 'SMS OTP was not delivered.');
      }
      return result;
    } catch (err) {
      const errMsg = err?.message || 'SMS send failed';
      const hint =
        settings.smsProvider === 'msg91'
          ? `${errMsg} Confirm MSG91_AUTH_KEY, MSG91_OTP_TEMPLATE_ID / Admin OTP template, and a valid 6-char sender ID.`
          : errMsg;
      warnings.push(hint);
      return { sent: false, provider: settings.smsProvider, delivered: false, warning: hint };
    }
  }

  async function runEmailChannel() {
    try {
      const result = await channelTimeout(
        sendEmailOtp({ email, otp: emailOtp, settings }),
        'Email OTP',
      );
      if (result?.delivered === false || result?.sent === false) {
        throw new Error(result.warning || 'Email OTP could not be delivered.');
      }
      if (result?.warning) warnings.push(result.warning);
      return result;
    } catch (err) {
      await sendEmailOtp({
        email,
        otp: emailOtp,
        settings: { ...settings, emailProvider: 'console' },
      }).catch(() => {});
      warnings.push(
        `Email OTP could not be sent (${err?.message || 'delivery failed'}). You can continue with mobile OTP only if SMS was delivered.`,
      );
      return { sent: false, provider: settings.emailProvider, delivered: false, degraded: true };
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
      }),
    );
  }

  await Promise.all(parallel);

  const emailDelivered = Boolean(
    outcomes.email && outcomes.email.delivered !== false && outcomes.email.sent !== false,
  );
  const smsDelivered = Boolean(
    outcomes.sms && outcomes.sms.sent !== false && outcomes.sms.delivered !== false,
  );

  if (settings.requireWhatsappOtp && phone) {
    try {
      outcomes.whatsapp = await channelTimeout(
        sendWhatsappOtp({ phone, otp: mobileOtp, settings }),
        'WhatsApp OTP',
      );
      if (outcomes.whatsapp?.warning) warnings.push(outcomes.whatsapp.warning);
    } catch (err) {
      warnings.push(err?.message || 'WhatsApp OTP failed');
      outcomes.whatsapp = { sent: false, delivered: false };
    }
  } else if (
    !smsDelivered
    && phone
    && settings.whatsappProvider === 'msg91'
    && isMsg91WhatsappConfigured(settings?.providerConfig)
  ) {
    // Fallback: if SMS did not deliver and WhatsApp MSG91 is fully configured, still try WhatsApp.
    try {
      outcomes.whatsapp = await channelTimeout(
        sendWhatsappOtp({ phone, otp: mobileOtp, settings }),
        'WhatsApp OTP',
      );
      if (outcomes.whatsapp?.warning) warnings.push(outcomes.whatsapp.warning);
    } catch (err) {
      warnings.push(err?.message || 'WhatsApp OTP fallback failed');
      outcomes.whatsapp = { sent: false, delivered: false };
    }
  }

  const whatsappDelivered = outcomes.whatsapp?.sent === true;
  const mobileChannelOk = smsDelivered || whatsappDelivered;

  if (
    !mobileChannelOk
    && !emailDelivered
    && (settings.requireMobileOtp !== false || settings.requireEmailOtp !== false || settings.requireWhatsappOtp)
  ) {
    const err = new Error(
      warnings.join(' ')
        || 'OTP could not be delivered on any channel. Check Admin → OTP settings and MSG91/SMTP credentials.',
    );
    err.status = 502;
    throw err;
  }

  return {
    mobileOtp: settings.requireMobileOtp !== false && mobileChannelOk ? mobileOtp : null,
    emailOtp: settings.requireEmailOtp !== false && emailDelivered ? emailOtp : null,
    smsProvider: settings.smsProvider,
    emailProvider: settings.emailProvider,
    whatsappProvider: settings.whatsappProvider,
    msg91Configured: isMsg91Configured(),
    emailDelivered,
    smsDelivered,
    whatsappDelivered,
    requireMobileOtp: settings.requireMobileOtp !== false && mobileChannelOk,
    requireEmailOtp: settings.requireEmailOtp !== false && emailDelivered,
    warnings,
    delivery: outcomes,
  };
}

