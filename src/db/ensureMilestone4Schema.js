import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { skipRuntimeSchemaOnPostgres } from './ensureHelpers.js';
import { getPool } from './pool.js';
import { isDuplicateColumnError } from './schemaErrors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let ensured = false;

async function tryAlter(sql) {
  const pool = getPool();
  try {
    await pool.execute(sql);
  } catch (err) {
    if (!isDuplicateColumnError(err)) throw err;
  }
}

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--[^\n]*\n/gm, '\n')
    .trim();
}

export async function ensureCibilCoreTables(pool = getPool()) {
  if (skipRuntimeSchemaOnPostgres()) return;
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS cibil_vendors (
      vendor_key VARCHAR(32) NOT NULL PRIMARY KEY,
      display_name VARCHAR(128) NOT NULL,
      api_key VARCHAR(512) NULL,
      api_secret VARCHAR(512) NULL,
      sandbox_mode TINYINT(1) NOT NULL DEFAULT 1,
      is_active TINYINT(1) NOT NULL DEFAULT 0,
      updated_by CHAR(36) NULL,
      updated_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    )`,
  );
  await pool.execute(
    `INSERT INTO cibil_vendors (vendor_key, display_name, sandbox_mode, is_active) VALUES
      ('transunion_cibil', 'TransUnion CIBIL', 1, 1),
      ('experian', 'Experian', 1, 0),
      ('equifax', 'Equifax', 1, 0),
      ('crif_high_mark', 'CRIF High Mark', 1, 0)
     ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,
  );
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS cibil_checks (
      id CHAR(36) NOT NULL PRIMARY KEY,
      application_id CHAR(36) NOT NULL,
      customer_id CHAR(36) NOT NULL,
      vendor_key VARCHAR(32) NOT NULL,
      status VARCHAR(32) NOT NULL,
      credit_score INT NULL,
      report_path TEXT NULL,
      error_message TEXT NULL,
      request_payload JSON NULL,
      response_payload JSON NULL,
      checked_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_cibil_app (application_id),
      KEY idx_cibil_customer (customer_id)
    )`,
  );
}

export async function ensureAgentOnboardingQcSchema() {
  if (skipRuntimeSchemaOnPostgres()) return;
  const pool = getPool();
  await tryAlter(
    `ALTER TABLE agent_onboarding ADD COLUMN qc_status VARCHAR(32) NOT NULL DEFAULT 'pending_qc'`,
  );
  await tryAlter(`ALTER TABLE agent_onboarding ADD COLUMN qc_employee_id CHAR(36) NULL`);
  await tryAlter(`ALTER TABLE agent_onboarding ADD COLUMN qc_notes TEXT NULL`);
  await tryAlter(`ALTER TABLE agent_onboarding ADD COLUMN qc_at DATETIME(3) NULL`);
  await tryAlter(`ALTER TABLE agent_onboarding ADD COLUMN qc_approved_by CHAR(36) NULL`);
}

export async function ensureMilestone4Schema() {
  if (skipRuntimeSchemaOnPostgres()) {
    ensured = true;
    return;
  }
  const pool = getPool();
  await ensureCibilCoreTables(pool);
  if (ensured) return;

  const sql = stripSqlComments(
    readFileSync(join(__dirname, '../../migrations/026_milestone4.sql'), 'utf8'),
  );
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('ALTER TABLE'));

  for (const statement of statements) {
    try {
      await pool.execute(statement);
    } catch (err) {
      if (err.code !== 'ER_TABLE_EXISTS_ERROR' && err.code !== 'ER_DUP_ENTRY') {
        throw err;
      }
    }
  }

  await tryAlter(
    `ALTER TABLE loan_applications ADD COLUMN journey_mode VARCHAR(32) NOT NULL DEFAULT 'assessment'`,
  );
  await tryAlter(`ALTER TABLE loan_applications ADD COLUMN cibil_status VARCHAR(32) NULL`);
  await tryAlter(`ALTER TABLE loan_applications ADD COLUMN cibil_checked_at DATETIME(3) NULL`);
  await tryAlter(`ALTER TABLE loan_applications ADD COLUMN disbursed_amount DECIMAL(15, 2) NULL`);
  await tryAlter(`ALTER TABLE loan_applications ADD COLUMN disbursed_at DATETIME(3) NULL`);
  await tryAlter(`ALTER TABLE loan_applications ADD COLUMN commission_status VARCHAR(32) NULL`);
  await tryAlter(`ALTER TABLE loan_applications ADD COLUMN commission_amount DECIMAL(15, 2) NULL`);
  await tryAlter(`ALTER TABLE loan_applications ADD COLUMN commission_rate DECIMAL(8, 4) NULL`);
  await tryAlter(`ALTER TABLE loan_applications ADD COLUMN tds_amount DECIMAL(15, 2) NULL`);
  await tryAlter(`ALTER TABLE loan_applications ADD COLUMN net_payout DECIMAL(15, 2) NULL`);
  await tryAlter(`ALTER TABLE loan_applications ADD COLUMN commission_paid_at DATETIME(3) NULL`);
  await tryAlter(
    `ALTER TABLE agent_onboarding ADD COLUMN qc_status VARCHAR(32) NOT NULL DEFAULT 'pending_qc'`,
  );
  await tryAlter(`ALTER TABLE agent_onboarding ADD COLUMN qc_employee_id CHAR(36) NULL`);
  await tryAlter(`ALTER TABLE agent_onboarding ADD COLUMN qc_notes TEXT NULL`);
  await tryAlter(`ALTER TABLE agent_onboarding ADD COLUMN qc_at DATETIME(3) NULL`);
  await tryAlter(`ALTER TABLE agent_onboarding ADD COLUMN qc_approved_by CHAR(36) NULL`);

  ensured = true;
}
