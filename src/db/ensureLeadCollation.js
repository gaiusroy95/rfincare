import { getPool } from './pool.js';

let ensured = false;

async function tryAlter(pool, sql) {
  try {
    await pool.execute(sql);
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR' && err.code !== 'ER_NO_SUCH_TABLE') {
      console.warn('[lead-collation]', err.message);
    }
  }
}

/** Align lead/OTP tables to utf8mb4_unicode_ci (fixes hosted MySQL collation mix errors). */
export async function ensureLeadCollation() {
  if (ensured) return;
  const pool = getPool();

  await tryAlter(
    pool,
    `ALTER TABLE marketing_leads
       MODIFY full_name VARCHAR(255) NULL COLLATE utf8mb4_unicode_ci,
       MODIFY email VARCHAR(255) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY phone VARCHAR(32) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY loan_type VARCHAR(64) NULL COLLATE utf8mb4_unicode_ci,
       MODIFY source VARCHAR(64) NOT NULL DEFAULT 'website' COLLATE utf8mb4_unicode_ci,
       MODIFY status VARCHAR(32) NOT NULL DEFAULT 'new' COLLATE utf8mb4_unicode_ci,
       MODIFY session_key VARCHAR(128) NULL COLLATE utf8mb4_unicode_ci`,
  );

  await tryAlter(
    pool,
    `ALTER TABLE lead_otps
       MODIFY email VARCHAR(255) NULL COLLATE utf8mb4_unicode_ci,
       MODIFY phone VARCHAR(32) NULL COLLATE utf8mb4_unicode_ci,
       MODIFY otp_hash VARCHAR(64) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY purpose VARCHAR(32) NOT NULL DEFAULT 'lead_verify' COLLATE utf8mb4_unicode_ci,
       MODIFY channel VARCHAR(16) NOT NULL DEFAULT 'sms' COLLATE utf8mb4_unicode_ci`,
  );

  await tryAlter(
    pool,
    `ALTER TABLE application_form_drafts
       MODIFY session_key VARCHAR(128) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY loan_type VARCHAR(64) NULL COLLATE utf8mb4_unicode_ci,
       MODIFY loan_priority VARCHAR(32) NULL COLLATE utf8mb4_unicode_ci`,
  );

  ensured = true;
}
