import { getPool } from './pool.js';

let ensured = false;

async function tryAlter(pool, sql) {
  try {
    await pool.execute(sql);
    return true;
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR' || err.code === 'ER_NO_SUCH_TABLE') {
      return false;
    }
    console.error('[lead-collation]', err.message);
    return false;
  }
}

async function readColumnCollation(pool, table, column) {
  try {
    const [[row]] = await pool.execute(
      `SELECT COLLATION_NAME AS collation
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = :table
         AND COLUMN_NAME = :column
       LIMIT 1`,
      { table, column },
    );
    return row?.collation || null;
  } catch {
    return null;
  }
}

const MARKETING_LEADS_ALTERS = [
  `ALTER TABLE marketing_leads MODIFY full_name VARCHAR(255) NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE marketing_leads MODIFY email VARCHAR(255) NOT NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE marketing_leads MODIFY phone VARCHAR(32) NOT NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE marketing_leads MODIFY loan_type VARCHAR(64) NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE marketing_leads MODIFY source VARCHAR(64) NOT NULL DEFAULT 'website' COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE marketing_leads MODIFY status VARCHAR(32) NOT NULL DEFAULT 'new' COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE marketing_leads MODIFY session_key VARCHAR(128) NULL COLLATE utf8mb4_unicode_ci`,
];

const LEAD_OTPS_ALTERS = [
  `ALTER TABLE lead_otps MODIFY email VARCHAR(255) NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE lead_otps MODIFY phone VARCHAR(32) NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE lead_otps MODIFY otp_hash VARCHAR(64) NOT NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE lead_otps MODIFY purpose VARCHAR(32) NOT NULL DEFAULT 'lead_verify' COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE lead_otps MODIFY channel VARCHAR(16) NOT NULL DEFAULT 'sms' COLLATE utf8mb4_unicode_ci`,
];

/** Align lead/OTP tables to utf8mb4_unicode_ci (fixes hosted MySQL collation mix errors). */
export async function ensureLeadCollation() {
  if (ensured) return;

  const pool = getPool();
  const before = await readColumnCollation(pool, 'marketing_leads', 'email');

  if (before === 'utf8mb4_unicode_ci') {
    ensured = true;
    return;
  }

  for (const sql of [...MARKETING_LEADS_ALTERS, ...LEAD_OTPS_ALTERS]) {
    await tryAlter(pool, sql);
  }

  await tryAlter(
    pool,
    `ALTER TABLE application_form_drafts
       MODIFY session_key VARCHAR(128) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY loan_type VARCHAR(64) NULL COLLATE utf8mb4_unicode_ci,
       MODIFY loan_priority VARCHAR(32) NULL COLLATE utf8mb4_unicode_ci`,
  );

  const after = await readColumnCollation(pool, 'marketing_leads', 'email');
  if (after && after !== 'utf8mb4_unicode_ci') {
    console.warn(
      `[lead-collation] marketing_leads.email collation is ${after}; query-level COLLATE fallback remains active`,
    );
  }

  ensured = true;
}
