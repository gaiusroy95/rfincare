import { getPool } from '../db/pool.js';
import { sqlCastParam, sqlParamEquals } from './sqlCollation.js';

export const AGENT_CODE_PREFIX = 'RFA';
const CODE_PATTERN = /^RFA-\d{6}$/;
const FY_CODE_PATTERN = /^RFA-\d{4}-\d{4}$/;

/** Indian FY label e.g. 2526 for Apr 2025 – Mar 2026. */
export function getIndianFinancialYearLabel(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth();
  const startYear = month >= 3 ? year : year - 1;
  const endYear = startYear + 1;
  return `${String(startYear).slice(-2)}${String(endYear).slice(-2)}`;
}

/** Format: RFA-000001 (6-digit sequence). */
export function formatAgentCode(sequenceNumber) {
  const n = Math.max(1, Number(sequenceNumber) || 1);
  return `${AGENT_CODE_PREFIX}-${String(n).padStart(6, '0')}`;
}

/** Format: RFA-2526-0001 (FY + 4-digit sequence). */
export function formatAgentCodeForFy(sequenceNumber, fyLabel) {
  const fy = String(fyLabel || getIndianFinancialYearLabel()).trim();
  const n = Math.max(1, Number(sequenceNumber) || 1);
  return `${AGENT_CODE_PREFIX}-${fy}-${String(n).padStart(4, '0')}`;
}

export function isValidAgentCode(code) {
  const value = String(code || '').trim().toUpperCase();
  return CODE_PATTERN.test(value) || FY_CODE_PATTERN.test(value);
}

async function nextSequenceNumber(pool) {
  const [[row]] = await pool.execute(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(agent_code, 5) AS UNSIGNED)), 0) AS max_seq
     FROM agent_onboarding
     WHERE agent_code REGEXP '^RFA-[0-9]{6}$'`,
  );
  return Number(row?.max_seq || 0) + 1;
}

async function nextFySequenceNumber(pool, fyLabel) {
  const fy = String(fyLabel || getIndianFinancialYearLabel()).trim();
  const pattern = `^RFA-${fy}-[0-9]{4}$`;
  const [[row]] = await pool.execute(
    `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(agent_code, '-', -1) AS UNSIGNED)), 0) AS max_seq
     FROM agent_onboarding
     WHERE agent_code REGEXP :pattern`,
    { pattern },
  );
  return Number(row?.max_seq || 0) + 1;
}

/** Reserve a unique RFA agent code (retries on collision). */
export async function reserveUniqueAgentCode(connOrPool) {
  const pool = connOrPool?.execute ? connOrPool : getPool();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const seq = (await nextSequenceNumber(pool)) + attempt;
    const code = formatAgentCode(seq);
    const [[existing]] = await pool.execute(
      `SELECT id FROM agent_onboarding
       WHERE ${sqlParamEquals('agent_code', 'code')}
       LIMIT 1`,
      { code },
    );
    if (!existing) return code;
  }
  throw new Error('Could not reserve unique agent code');
}

/** Reserve FY-scoped agent code e.g. RFA-2526-0001. */
export async function reserveUniqueAgentCodeForFy(connOrPool, fyLabel) {
  const pool = connOrPool?.execute ? connOrPool : getPool();
  const fy = String(fyLabel || getIndianFinancialYearLabel()).trim();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const seq = (await nextFySequenceNumber(pool, fy)) + attempt;
    const code = formatAgentCodeForFy(seq, fy);
    const [[existing]] = await pool.execute(
      `SELECT id FROM agent_onboarding
       WHERE ${sqlParamEquals('agent_code', 'code')}
       LIMIT 1`,
      { code },
    );
    if (!existing) return { code, financialYear: fy };
  }
  throw new Error('Could not reserve unique FY agent code');
}

/**
 * Assign RFA code when missing on agent_onboarding (existing agents included).
 * Returns the active code or null if no onboarding row exists.
 */
export async function ensureAgentCodeForUser(connOrPool, userId) {
  if (!userId) return null;
  const pool = connOrPool?.execute ? connOrPool : getPool();
  const [[row]] = await pool.execute(
    `SELECT agent_code FROM agent_onboarding WHERE user_id = :id LIMIT 1`,
    { id: userId },
  );
  if (!row) return null;

  const existing = String(row.agent_code || '').trim();
  if (existing) return existing;

  const code = await reserveUniqueAgentCode(pool);
  await pool.execute(
    `UPDATE agent_onboarding SET agent_code = ${sqlCastParam('code')}, updated_at = NOW(3)
     WHERE user_id = :id
       AND (agent_code IS NULL OR LENGTH(TRIM(agent_code)) = 0)`,
    { code, id: userId },
  );
  return code;
}

let backfillDone = false;

/** One-time lazy backfill for agents created without a code. */
export async function backfillMissingAgentCodes(connOrPool) {
  if (backfillDone) return;
  const pool = connOrPool?.execute ? connOrPool : getPool();
  const [rows] = await pool.execute(
    `SELECT user_id FROM agent_onboarding
     WHERE agent_code IS NULL OR LENGTH(TRIM(agent_code)) = 0`,
  );
  for (const row of rows) {
    await ensureAgentCodeForUser(pool, row.user_id);
  }
  backfillDone = true;
}
