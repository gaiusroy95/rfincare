import { getPool } from "../db/pool.js";
import { sqlCastParam, sqlParamEquals } from "./sqlCollation.js";
const AGENT_CODE_PREFIX = "RFA";
const CODE_PATTERN = /^RFA-\d{6}$/;
const FY_CODE_PATTERN = /^RFA-\d{4}-\d{4}$/;
function getIndianFinancialYearLabel(date = /* @__PURE__ */ new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const year = d.getFullYear();
  const month = d.getMonth();
  const startYear = month >= 3 ? year : year - 1;
  const endYear = startYear + 1;
  return `${String(startYear).slice(-2)}${String(endYear).slice(-2)}`;
}
function formatAgentCode(sequenceNumber) {
  const n = Math.max(1, Number(sequenceNumber) || 1);
  return `${AGENT_CODE_PREFIX}-${String(n).padStart(6, "0")}`;
}
function formatAgentCodeForFy(sequenceNumber, fyLabel) {
  const fy = String(fyLabel || getIndianFinancialYearLabel()).trim();
  const n = Math.max(1, Number(sequenceNumber) || 1);
  return `${AGENT_CODE_PREFIX}-${fy}-${String(n).padStart(4, "0")}`;
}
function isValidAgentCode(code) {
  const value = String(code || "").trim().toUpperCase();
  return CODE_PATTERN.test(value) || FY_CODE_PATTERN.test(value);
}
async function nextSequenceNumber(pool) {
  const [[row]] = await pool.execute(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(agent_code FROM 5) AS INTEGER)), 0) AS max_seq
     FROM agent_onboarding
     WHERE agent_code ~ '^RFA-[0-9]{6}$'`
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
    { pattern }
  );
  return Number(row?.max_seq || 0) + 1;
}
async function reserveUniqueAgentCode(connOrPool) {
  const pool = connOrPool?.execute ? connOrPool : getPool();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const seq = await nextSequenceNumber(pool) + attempt;
    const code = formatAgentCode(seq);
    const [[existing]] = await pool.execute(
      `SELECT id FROM agent_onboarding
       WHERE ${sqlParamEquals("agent_code", "code")}
       LIMIT 1`,
      { code }
    );
    if (!existing) return code;
  }
  throw new Error("Could not reserve unique agent code");
}
async function reserveUniqueAgentCodeForFy(connOrPool, fyLabel) {
  const pool = connOrPool?.execute ? connOrPool : getPool();
  const fy = String(fyLabel || getIndianFinancialYearLabel()).trim();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const seq = await nextFySequenceNumber(pool, fy) + attempt;
    const code = formatAgentCodeForFy(seq, fy);
    const [[existing]] = await pool.execute(
      `SELECT id FROM agent_onboarding
       WHERE ${sqlParamEquals("agent_code", "code")}
       LIMIT 1`,
      { code }
    );
    if (!existing) return { code, financialYear: fy };
  }
  throw new Error("Could not reserve unique FY agent code");
}
async function ensureAgentCodeForUser(connOrPool, userId) {
  if (!userId) return null;
  const pool = connOrPool?.execute ? connOrPool : getPool();
  const [[profile]] = await pool.execute(
    `SELECT id, role, full_name, email, phone
     FROM user_profiles
     WHERE id = :id
     LIMIT 1`,
    { id: userId }
  );
  if (!profile) return null;
  const role = String(profile.role || "").toLowerCase();
  const [[row]] = await pool.execute(
    `SELECT id, agent_code FROM agent_onboarding WHERE user_id = :id LIMIT 1`,
    { id: userId }
  );
  if (!row) {
    if (role !== "agent") {
      return null;
    }
    const { newId } = await import("./ids.js");
    const code2 = await reserveUniqueAgentCode(pool);
    const email = String(profile.email || `${userId}@agents.local`).trim().toLowerCase();
    const name = String(profile.full_name || "Agent").trim() || "Agent";
    const usernameBase = email.split("@")[0].replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 24) || "agent";
    const username = `${usernameBase}_${String(userId).replace(/-/g, "").slice(0, 8)}`;
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
          agent_code: code2,
          email,
          mobile: String(profile.phone || "0000000000").slice(0, 32),
          acc: "PENDING",
          bank: "PENDING",
          ifsc: "PENDING"
        }
      );
      return code2;
    } catch (err) {
      const [[again]] = await pool.execute(
        `SELECT agent_code FROM agent_onboarding WHERE user_id = :id LIMIT 1`,
        { id: userId }
      );
      const existing2 = String(again?.agent_code || "").trim();
      if (existing2) return existing2;
      console.warn("[agentCode] failed to create onboarding:", err?.message);
      return null;
    }
  }
  const existing = String(row.agent_code || "").trim();
  if (existing) return existing;
  const code = await reserveUniqueAgentCode(pool);
  await pool.execute(
    `UPDATE agent_onboarding SET agent_code = ${sqlCastParam("code")}, updated_at = NOW()
     WHERE user_id = :id
       AND (agent_code IS NULL OR LENGTH(TRIM(agent_code)) = 0)`,
    { code, id: userId }
  );
  return code;
}
let backfillDone = false;
async function backfillMissingAgentCodes(connOrPool) {
  if (backfillDone) return;
  const pool = connOrPool?.execute ? connOrPool : getPool();
  const [rows] = await pool.execute(
    `SELECT user_id FROM agent_onboarding
     WHERE agent_code IS NULL OR LENGTH(TRIM(agent_code)) = 0`
  );
  for (const row of rows) {
    await ensureAgentCodeForUser(pool, row.user_id);
  }
  backfillDone = true;
}
export {
  AGENT_CODE_PREFIX,
  backfillMissingAgentCodes,
  ensureAgentCodeForUser,
  formatAgentCode,
  formatAgentCodeForFy,
  getIndianFinancialYearLabel,
  isValidAgentCode,
  reserveUniqueAgentCode,
  reserveUniqueAgentCodeForFy
};
