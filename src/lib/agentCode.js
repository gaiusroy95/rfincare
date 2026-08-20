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
    `SELECT COALESCE(MAX(CAST(SUBSTRING(agent_code FROM 5) AS INTEGER)), 0) AS max_seq
     FROM agent_onboarding
     WHERE agent_code ~ '^RFA-[0-9]{6}$'`,
  );
  return Number(row?.max_seq || 0) + 1;
}

async function nextFySequenceNumber(pool, fyLabel) {
  const fy = String(fyLabel || getIndianFinancialYearLabel()).trim();
  const pattern = `^RFA-${fy}-[0-9]{4}$`;
  const [[row]] = await pool.execute(
    `SELECT COALESCE(MAX(CAST(split_part(agent_code, '-', 3) AS INTEGER)), 0) AS max_seq
     FROM agent_onboarding
     WHERE agent_code ~ :pattern`,
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
 * Creates a minimal onboarding row when the user is an agent but has none.
 * Returns the active code or null if the user is not an agent.
 */
export async function ensureAgentCodeForUser(connOrPool, userId) {
  if (!userId) return null;
  const pool = connOrPool?.execute ? connOrPool : getPool();

  const [[profile]] = await pool.execute(
    `SELECT id, role, full_name, email, phone
     FROM user_profiles
     WHERE id = :id
     LIMIT 1`,
    { id: userId },
  );
  if (!profile) return null;

  const role = String(profile.role || '').toLowerCase();
  const [[row]] = await pool.execute(
    `SELECT id, agent_code FROM agent_onboarding WHERE user_id = :id LIMIT 1`,
    { id: userId },
  );

  if (!row) {
    if (role !== 'agent') {
      return null;
    }
    // Agent accounts created without onboarding still need a code for attribution.
    const { newId } = await import('./ids.js');
    const code = await reserveUniqueAgentCode(pool);
    const email = String(profile.email || `${userId}@agents.local`).trim().toLowerCase();
    const name = String(profile.full_name || 'Agent').trim() || 'Agent';
    const usernameBase = email.split('@')[0].replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 24) || 'agent';
    const username = `${usernameBase}_${String(userId).replace(/-/g, '').slice(0, 8)}`;
    try {
      await pool.execute(
        `INSERT INTO agent_onboarding (
           id, user_id, username, agent_name, agent_code, email, mobile_number,
           account_number, bank_name, ifsc_code, onboarding_status
         ) VALUES (
           :id, :user_id, :username, :agent_name, :agent_code, :email, :mobile,
           :acc, :bank, :ifsc, 'active'
         )`,
        {
          id: newId(),
          user_id: userId,
          username,
          agent_name: name,
          agent_code: code,
          email,
          mobile: String(profile.phone || '0000000000').slice(0, 32),
          acc: 'PENDING',
          bank: 'PENDING',
          ifsc: 'PENDING',
        },
      );
      return code;
    } catch (err) {
      // Race: another request may have inserted; re-read.
      const [[again]] = await pool.execute(
        `SELECT agent_code FROM agent_onboarding WHERE user_id = :id LIMIT 1`,
        { id: userId },
      );
      const existing = String(again?.agent_code || '').trim();
      if (existing) return existing;
      console.warn('[agentCode] failed to create onboarding:', err?.message);
      return null;
    }
  }

  const existing = String(row.agent_code || '').trim();
  if (existing) return existing;

  const code = await reserveUniqueAgentCode(pool);
  await pool.execute(
    `UPDATE agent_onboarding SET agent_code = ${sqlCastParam('code')}, updated_at = NOW()
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
