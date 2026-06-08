import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPool } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let ensured = false;
let collationEnsured = false;

async function tryAlter(pool, sql) {
  try {
    await pool.execute(sql);
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR' && err.code !== 'ER_NO_SUCH_TABLE') {
      console.warn('[onboarding-schema]', err.message);
    }
  }
}

/** Align string columns to utf8mb4_unicode_ci (fixes hosted MySQL collation mix errors). */
export async function ensureStaffOnboardingCollation() {
  if (collationEnsured) return;
  const pool = getPool();

  await tryAlter(
    pool,
    `ALTER TABLE auth_users MODIFY email VARCHAR(320) NOT NULL COLLATE utf8mb4_unicode_ci`,
  );
  await tryAlter(
    pool,
    `ALTER TABLE user_profiles
       MODIFY email VARCHAR(320) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY full_name VARCHAR(255) NULL COLLATE utf8mb4_unicode_ci,
       MODIFY phone VARCHAR(32) NULL COLLATE utf8mb4_unicode_ci,
       MODIFY role VARCHAR(32) NOT NULL DEFAULT 'customer' COLLATE utf8mb4_unicode_ci,
       MODIFY account_status VARCHAR(32) NOT NULL DEFAULT 'active' COLLATE utf8mb4_unicode_ci,
       MODIFY onboarding_status VARCHAR(64) NULL COLLATE utf8mb4_unicode_ci`,
  );
  await tryAlter(
    pool,
    `ALTER TABLE agent_onboarding
       MODIFY username VARCHAR(128) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY agent_name VARCHAR(255) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY agent_code VARCHAR(64) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY email VARCHAR(320) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY mobile_number VARCHAR(32) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY account_number VARCHAR(64) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY bank_name VARCHAR(255) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY ifsc_code VARCHAR(32) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY onboarding_status VARCHAR(32) NOT NULL DEFAULT 'pending' COLLATE utf8mb4_unicode_ci`,
  );
  await tryAlter(
    pool,
    `ALTER TABLE employee_onboarding
       MODIFY username VARCHAR(128) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY employee_name VARCHAR(255) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY employee_code VARCHAR(64) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY email VARCHAR(320) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY mobile_number VARCHAR(32) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY account_number VARCHAR(64) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY bank_name VARCHAR(255) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY ifsc_code VARCHAR(32) NOT NULL COLLATE utf8mb4_unicode_ci,
       MODIFY onboarding_status VARCHAR(32) NOT NULL DEFAULT 'pending' COLLATE utf8mb4_unicode_ci`,
  );
  await tryAlter(
    pool,
    `ALTER TABLE agent_onboarding
       MODIFY qc_status VARCHAR(32) NOT NULL DEFAULT 'pending_qc' COLLATE utf8mb4_unicode_ci`,
  );

  collationEnsured = true;
}

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--[^\n]*\n/gm, '\n')
    .trim();
}

export async function ensureOnboardingSchema() {
  if (ensured) return;
  const sql = stripSqlComments(
    readFileSync(join(__dirname, '../../migrations/009_agent_employee_onboarding.sql'), 'utf8'),
  );
  const pool = getPool();
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await pool.execute(statement);
  }
  await ensureStaffOnboardingCollation();
  ensured = true;
}
