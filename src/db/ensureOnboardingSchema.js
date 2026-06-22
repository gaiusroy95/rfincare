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
    return true;
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR' && err.code !== 'ER_NO_SUCH_TABLE') {
      console.warn('[onboarding-schema]', err.message);
    }
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

const AUTH_USERS_ALTERS = [
  `ALTER TABLE auth_users MODIFY email VARCHAR(320) NOT NULL COLLATE utf8mb4_unicode_ci`,
];

const USER_PROFILES_ALTERS = [
  `ALTER TABLE user_profiles MODIFY email VARCHAR(320) NOT NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE user_profiles MODIFY full_name VARCHAR(255) NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE user_profiles MODIFY phone VARCHAR(32) NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE user_profiles MODIFY role VARCHAR(32) NOT NULL DEFAULT 'customer' COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE user_profiles MODIFY account_status VARCHAR(32) NOT NULL DEFAULT 'active' COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE user_profiles MODIFY onboarding_status VARCHAR(64) NULL COLLATE utf8mb4_unicode_ci`,
];

const AGENT_ONBOARDING_ALTERS = [
  `ALTER TABLE agent_onboarding MODIFY username VARCHAR(128) NOT NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE agent_onboarding MODIFY agent_name VARCHAR(255) NOT NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE agent_onboarding MODIFY agent_code VARCHAR(64) NOT NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE agent_onboarding MODIFY email VARCHAR(320) NOT NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE agent_onboarding MODIFY mobile_number VARCHAR(32) NOT NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE agent_onboarding MODIFY account_number VARCHAR(64) NOT NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE agent_onboarding MODIFY bank_name VARCHAR(255) NOT NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE agent_onboarding MODIFY ifsc_code VARCHAR(32) NOT NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE agent_onboarding MODIFY onboarding_status VARCHAR(32) NOT NULL DEFAULT 'pending' COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE agent_onboarding MODIFY qc_status VARCHAR(32) NOT NULL DEFAULT 'pending_qc' COLLATE utf8mb4_unicode_ci`,
];

const EMPLOYEE_ONBOARDING_ALTERS = [
  `ALTER TABLE employee_onboarding MODIFY username VARCHAR(128) NOT NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE employee_onboarding MODIFY employee_name VARCHAR(255) NOT NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE employee_onboarding MODIFY employee_code VARCHAR(64) NOT NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE employee_onboarding MODIFY email VARCHAR(320) NOT NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE employee_onboarding MODIFY mobile_number VARCHAR(32) NOT NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE employee_onboarding MODIFY account_number VARCHAR(64) NOT NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE employee_onboarding MODIFY bank_name VARCHAR(255) NOT NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE employee_onboarding MODIFY ifsc_code VARCHAR(32) NOT NULL COLLATE utf8mb4_unicode_ci`,
  `ALTER TABLE employee_onboarding MODIFY onboarding_status VARCHAR(32) NOT NULL DEFAULT 'pending' COLLATE utf8mb4_unicode_ci`,
];

/** Align staff onboarding tables to utf8mb4_unicode_ci (fixes hosted MySQL collation mix errors). */
export async function ensureStaffOnboardingCollation() {
  if (collationEnsured) return;
  const pool = getPool();

  const before = await readColumnCollation(pool, 'user_profiles', 'role');
  if (before === 'utf8mb4_unicode_ci') {
    collationEnsured = true;
    return;
  }

  for (const sql of [
    ...AUTH_USERS_ALTERS,
    ...USER_PROFILES_ALTERS,
    ...AGENT_ONBOARDING_ALTERS,
    ...EMPLOYEE_ONBOARDING_ALTERS,
  ]) {
    await tryAlter(pool, sql);
  }

  const after = await readColumnCollation(pool, 'user_profiles', 'role');
  if (after && after !== 'utf8mb4_unicode_ci') {
    console.warn(
      `[onboarding-schema] user_profiles.role collation is ${after}; query-level COLLATE fallback remains active`,
    );
  }

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
