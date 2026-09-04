import { dbBool } from "../db/boolean.js";
import { getPool } from "../db/pool.js";
const SETTINGS_ID = "default";
let ensured = false;
const SMS_PROVIDERS = ["console", "twilio", "msg91"];
const EMAIL_PROVIDERS = ["console", "smtp", "msg91"];
const WHATSAPP_PROVIDERS = ["console", "twilio", "msg91"];
const DEFAULTS = {
  smsProvider: "console",
  whatsappProvider: "console",
  emailProvider: "console",
  requireMobileOtp: true,
  requireEmailOtp: true,
  requireWhatsappOtp: false,
  providerConfig: {
    msg91SenderId: "",
    msg91TemplateId: "",
    msg91OtpTemplateId: "",
    msg91FlowTemplateId: "",
    msg91WhatsappTemplateId: "",
    msg91WhatsappNamespace: "",
    msg91WhatsappIntegratedNumber: "",
    msg91WhatsappLanguage: "en",
    msg91WhatsappIncludeButton: true,
    msg91WhatsappOmitButton: false,
    msg91EmailDomain: "",
    msg91EmailFromEmail: "",
    msg91EmailFromName: "",
    msg91EmailOtpTemplateId: "",
    msg91EmailOtpVariable: "OTP_CODE",
    otpMessageTemplate: "Your Rfincare verification code is {{otp}}. Valid for 10 minutes."
  }
};
function parseConfig(value) {
  if (!value) return { ...DEFAULTS.providerConfig };
  if (typeof value === "object") return { ...DEFAULTS.providerConfig, ...value };
  try {
    const parsed = JSON.parse(value);
    return { ...DEFAULTS.providerConfig, ...parsed || {} };
  } catch {
    return { ...DEFAULTS.providerConfig };
  }
}
async function ensureOtpProviderSchema() {
  ensured = true;
}
function formatRow(row) {
  if (!row) {
    return mergeEnvIntoProviderConfig({ ...DEFAULTS });
  }
  return mergeEnvIntoProviderConfig({
    smsProvider: SMS_PROVIDERS.includes(row.sms_provider) ? row.sms_provider : "console",
    whatsappProvider: WHATSAPP_PROVIDERS.includes(row.whatsapp_provider) ? row.whatsapp_provider : "console",
    emailProvider: EMAIL_PROVIDERS.includes(row.email_provider) ? row.email_provider : "console",
    requireMobileOtp: dbBool(row.require_mobile_otp, true),
    requireEmailOtp: dbBool(row.require_email_otp, true),
    requireWhatsappOtp: dbBool(row.require_whatsapp_otp),
    providerConfig: parseConfig(row.provider_config_json),
    updatedAt: row.updated_at
  });
}
function mergeEnvIntoProviderConfig(settings) {
  const cfg = { ...DEFAULTS.providerConfig, ...settings.providerConfig || {} };
  const fill = (key, envKeys) => {
    if (String(cfg[key] || "").trim()) return;
    for (const envKey of envKeys) {
      const value = process.env[envKey];
      if (value && String(value).trim()) {
        cfg[key] = String(value).trim();
        return;
      }
    }
  };
  fill("msg91SenderId", ["MSG91_SENDER_ID"]);
  fill("msg91OtpTemplateId", ["MSG91_OTP_TEMPLATE_ID", "MSG91_TEMPLATE_ID"]);
  fill("msg91TemplateId", ["MSG91_OTP_TEMPLATE_ID", "MSG91_TEMPLATE_ID"]);
  fill("msg91FlowTemplateId", ["MSG91_FLOW_TEMPLATE_ID"]);
  fill("msg91WhatsappTemplateId", ["MSG91_WHATSAPP_TEMPLATE_ID"]);
  fill("msg91WhatsappNamespace", ["MSG91_WHATSAPP_NAMESPACE"]);
  fill("msg91WhatsappIntegratedNumber", ["MSG91_WHATSAPP_INTEGRATED_NUMBER"]);
  fill("msg91WhatsappLanguage", ["MSG91_WHATSAPP_LANGUAGE"]);
  fill("msg91EmailDomain", ["MSG91_EMAIL_DOMAIN"]);
  fill("msg91EmailFromEmail", ["MSG91_EMAIL_FROM_EMAIL", "MSG91_EMAIL_FROM"]);
  fill("msg91EmailFromName", ["MSG91_EMAIL_FROM_NAME"]);
  fill("msg91EmailOtpTemplateId", ["MSG91_EMAIL_OTP_TEMPLATE_ID"]);
  fill("msg91EmailOtpVariable", ["MSG91_EMAIL_OTP_VARIABLE"]);
  const senderNorm = String(cfg.msg91SenderId || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (senderNorm.length !== 6) {
    const envSender = String(process.env.MSG91_SENDER_ID || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (envSender.length === 6) cfg.msg91SenderId = envSender;
  } else {
    cfg.msg91SenderId = senderNorm;
  }
  return { ...settings, providerConfig: cfg };
}
async function getOtpProviderSettings() {
  await ensureOtpProviderSchema();
  const pool = getPool();
  const [[row]] = await pool.execute(
    `SELECT * FROM otp_provider_settings WHERE id = :id LIMIT 1`,
    { id: SETTINGS_ID }
  );
  return formatRow(row);
}
async function updateOtpProviderSettings(input, updatedBy) {
  await ensureOtpProviderSchema();
  const pool = getPool();
  const smsProvider = SMS_PROVIDERS.includes(input.smsProvider) ? input.smsProvider : "console";
  const whatsappProvider = WHATSAPP_PROVIDERS.includes(input.whatsappProvider) ? input.whatsappProvider : "console";
  const emailProvider = EMAIL_PROVIDERS.includes(input.emailProvider) ? input.emailProvider : "console";
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
        ...input.providerConfig || {}
      }),
      updated_by: updatedBy ?? null
    }
  );
  return getOtpProviderSettings();
}
export {
  EMAIL_PROVIDERS,
  SMS_PROVIDERS,
  WHATSAPP_PROVIDERS,
  ensureOtpProviderSchema,
  getOtpProviderSettings,
  updateOtpProviderSettings
};
