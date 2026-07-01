import { dbBool } from '../db/boolean.js';
import { getPool } from '../db/pool.js';
const SETTINGS_ID = 'default';
let ensured = false;

export const SMS_PROVIDERS = ['console', 'twilio', 'msg91'];
export const EMAIL_PROVIDERS = ['console', 'smtp', 'msg91'];
export const WHATSAPP_PROVIDERS = ['console', 'twilio', 'msg91'];

const DEFAULTS = {
  smsProvider: 'console',
  whatsappProvider: 'console',
  emailProvider: 'console',
  requireMobileOtp: true,
  requireEmailOtp: true,
  requireWhatsappOtp: false,
  providerConfig: {
    msg91SenderId: '',
    msg91TemplateId: '',
    msg91OtpTemplateId: '',
    msg91FlowTemplateId: '',
    msg91WhatsappTemplateId: '',
    msg91EmailDomain: '',
    msg91EmailFromEmail: '',
    msg91EmailFromName: '',
    msg91EmailOtpTemplateId: '',
    msg91EmailOtpVariable: 'OTP_CODE',
    otpMessageTemplate: 'Your Rfincare verification code is {{otp}}. Valid for 10 minutes.',
  },
};

function parseConfig(value) {
  if (!value) return { ...DEFAULTS.providerConfig };
  if (typeof value === 'object') return { ...DEFAULTS.providerConfig, ...value };
  try {
    const parsed = JSON.parse(value);
    return { ...DEFAULTS.providerConfig, ...(parsed || {}) };
  } catch {
    return { ...DEFAULTS.providerConfig };
  }
}

export async function ensureOtpProviderSchema() {
  ensured = true;
}

function formatRow(row) {
  if (!row) {
    return { ...DEFAULTS };
  }
  return {
    smsProvider: SMS_PROVIDERS.includes(row.sms_provider) ? row.sms_provider : 'console',
    whatsappProvider: WHATSAPP_PROVIDERS.includes(row.whatsapp_provider)
      ? row.whatsapp_provider
      : 'console',
    emailProvider: EMAIL_PROVIDERS.includes(row.email_provider) ? row.email_provider : 'console',
    requireMobileOtp: dbBool(row.require_mobile_otp, true),
    requireEmailOtp: dbBool(row.require_email_otp, true),
    requireWhatsappOtp: dbBool(row.require_whatsapp_otp),
    providerConfig: parseConfig(row.provider_config_json),
    updatedAt: row.updated_at,
  };
}

export async function getOtpProviderSettings() {
  await ensureOtpProviderSchema();
  const pool = getPool();
  const [[row]] = await pool.execute(
    `SELECT * FROM otp_provider_settings WHERE id = :id LIMIT 1`,
    { id: SETTINGS_ID },
  );
  return formatRow(row);
}

export async function updateOtpProviderSettings(input, updatedBy) {
  await ensureOtpProviderSchema();
  const pool = getPool();

  const smsProvider = SMS_PROVIDERS.includes(input.smsProvider) ? input.smsProvider : 'console';
  const whatsappProvider = WHATSAPP_PROVIDERS.includes(input.whatsappProvider)
    ? input.whatsappProvider
    : 'console';
  const emailProvider = EMAIL_PROVIDERS.includes(input.emailProvider)
    ? input.emailProvider
    : 'console';

  await pool.execute(
    `INSERT INTO otp_provider_settings (
       id, sms_provider, whatsapp_provider, email_provider,
       require_mobile_otp, require_email_otp, require_whatsapp_otp,
       provider_config_json, updated_by
     ) VALUES (
       :id, :sms, :whatsapp, :email, :req_mobile, :req_email, :req_whatsapp, :config, :updated_by
     ) ON CONFLICT (id) DO UPDATE SET sms_provider = EXCLUDED.sms_provider,
       whatsapp_provider = EXCLUDED.whatsapp_provider,
       email_provider = EXCLUDED.email_provider,
       require_mobile_otp = EXCLUDED.require_mobile_otp,
       require_email_otp = EXCLUDED.require_email_otp,
       require_whatsapp_otp = EXCLUDED.require_whatsapp_otp,
       provider_config_json = EXCLUDED.provider_config_json,
       updated_by = EXCLUDED.updated_by`,
    {
      id: SETTINGS_ID,
      sms: smsProvider,
      whatsapp: whatsappProvider,
      email: emailProvider,
      req_mobile: input.requireMobileOtp !== false ? 1 : 0,
      req_email: input.requireEmailOtp !== false ? 1 : 0,
      req_whatsapp: input.requireWhatsappOtp === true ? 1 : 0,
      config: JSON.stringify({
        ...DEFAULTS.providerConfig,
        ...(input.providerConfig || {}),
      }),
      updated_by: updatedBy ?? null,
    },
  );

  return getOtpProviderSettings();
}