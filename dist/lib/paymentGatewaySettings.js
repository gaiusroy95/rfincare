import { getPool } from "../db/pool.js";
const SETTINGS_ID = "default";
const DEFAULTS = {
  provider: "razorpay",
  isEnabled: true,
  mode: "live",
  keyId: "",
  hasKeySecret: false,
  hasWebhookSecret: false,
  notes: ""
};
function maskSecret(value) {
  const s = String(value || "");
  if (!s) return "";
  if (s.length <= 8) return "********";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
async function ensureTable(pool) {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS payment_gateway_settings (
      id CHAR(36) NOT NULL,
      provider VARCHAR(32) NOT NULL DEFAULT 'razorpay',
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      mode VARCHAR(16) NOT NULL DEFAULT 'live',
      key_id VARCHAR(128) NULL,
      key_secret_encrypted TEXT NULL,
      webhook_secret_encrypted TEXT NULL,
      notes TEXT NULL,
      updated_by CHAR(36) NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )
  `);
  await pool.execute(
    `INSERT INTO payment_gateway_settings (id, provider, is_enabled, mode)
     VALUES ('default', 'razorpay', TRUE, 'live')
     ON CONFLICT (id) DO NOTHING`
  );
}
async function getPaymentGatewaySettingsPublic() {
  const pool = getPool();
  await ensureTable(pool);
  const [[row]] = await pool.execute(
    `SELECT * FROM payment_gateway_settings WHERE id = :id LIMIT 1`,
    { id: SETTINGS_ID }
  );
  const envKeyId = String(process.env.RAZORPAY_KEY_ID || "").trim();
  const envKeySecret = String(process.env.RAZORPAY_KEY_SECRET || "").trim();
  const envWebhook = String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();
  if (!row) {
    return {
      ...DEFAULTS,
      keyId: envKeyId,
      keyIdMasked: maskSecret(envKeyId),
      hasKeySecret: Boolean(envKeySecret),
      hasWebhookSecret: Boolean(envWebhook),
      source: envKeyId || envKeySecret ? "env" : "none"
    };
  }
  const keyId = String(row.key_id || "").trim() || envKeyId;
  return {
    provider: row.provider || "razorpay",
    isEnabled: row.is_enabled !== false && row.is_enabled !== 0,
    mode: row.mode || "live",
    keyId,
    keyIdMasked: maskSecret(keyId),
    hasKeySecret: Boolean(String(row.key_secret_encrypted || "").trim() || envKeySecret),
    hasWebhookSecret: Boolean(String(row.webhook_secret_encrypted || "").trim() || envWebhook),
    notes: row.notes || "",
    updatedAt: row.updated_at,
    source: row.key_id || row.key_secret_encrypted ? "database" : envKeyId ? "env" : "none"
  };
}
async function resolveRazorpayCredentials() {
  const pool = getPool();
  await ensureTable(pool);
  const [[row]] = await pool.execute(
    `SELECT * FROM payment_gateway_settings WHERE id = :id LIMIT 1`,
    { id: SETTINGS_ID }
  );
  const keyId = String(row?.key_id || "").trim() || String(process.env.RAZORPAY_KEY_ID || "").trim();
  const keySecret = String(row?.key_secret_encrypted || "").trim() || String(process.env.RAZORPAY_KEY_SECRET || "").trim();
  const webhookSecret = String(row?.webhook_secret_encrypted || "").trim() || String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();
  const isEnabled = row ? row.is_enabled !== false && row.is_enabled !== 0 : true;
  return {
    isEnabled,
    mode: row?.mode || "live",
    keyId,
    keySecret,
    webhookSecret
  };
}
async function savePaymentGatewaySettings(body = {}, updatedBy) {
  const pool = getPool();
  await ensureTable(pool);
  const isEnabled = body.isEnabled !== false && body.is_enabled !== false;
  const mode = String(body.mode || "live").toLowerCase() === "test" ? "test" : "live";
  const keyId = body.keyId !== void 0 ? String(body.keyId || "").trim() : void 0;
  const keySecret = body.keySecret !== void 0 ? String(body.keySecret || "").trim() : void 0;
  const webhookSecret = body.webhookSecret !== void 0 ? String(body.webhookSecret || "").trim() : void 0;
  const notes = body.notes !== void 0 ? String(body.notes || "") : void 0;
  await pool.execute(
    `UPDATE payment_gateway_settings SET
       is_enabled = :is_enabled,
       mode = :mode,
       key_id = COALESCE(:key_id, key_id),
       key_secret_encrypted = CASE
         WHEN :set_key_secret = 1 THEN :key_secret
         ELSE key_secret_encrypted
       END,
       webhook_secret_encrypted = CASE
         WHEN :set_webhook_secret = 1 THEN :webhook_secret
         ELSE webhook_secret_encrypted
       END,
       notes = COALESCE(:notes, notes),
       updated_by = :updated_by,
       updated_at = NOW()
     WHERE id = :id`,
    {
      id: SETTINGS_ID,
      is_enabled: isEnabled,
      mode,
      key_id: keyId === void 0 ? null : keyId || null,
      set_key_secret: keySecret !== void 0 && keySecret !== "" ? 1 : 0,
      key_secret: keySecret || null,
      set_webhook_secret: webhookSecret !== void 0 && webhookSecret !== "" ? 1 : 0,
      webhook_secret: webhookSecret || null,
      notes: notes === void 0 ? null : notes,
      updated_by: updatedBy || null
    }
  );
  return getPaymentGatewaySettingsPublic();
}
export {
  getPaymentGatewaySettingsPublic,
  resolveRazorpayCredentials,
  savePaymentGatewaySettings
};
