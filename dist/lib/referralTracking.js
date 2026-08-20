import { randomUUID } from "node:crypto";
import { getPool, isDuplicateColumnError, isIgnorableMigrationError } from "../db/pool.js";
import { newId } from "./ids.js";
import { ensureAgentCodeForUser } from "./agentCode.js";
import { assignUniqueCustomerCode } from "./customerCode.js";
import { sqlCastParam } from "./sqlCollation.js";
const PROGRAMS = /* @__PURE__ */ new Set(["agent", "customer"]);
function normalizeReferralCode(value) {
  if (!value) return null;
  const code = String(value).trim().toUpperCase();
  return code.length >= 4 ? code : null;
}
function normalizeReferralProgram(value) {
  const program = String(value || "").trim().toLowerCase();
  return PROGRAMS.has(program) ? program : null;
}
function generateProgramCode(program) {
  const hex = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  return program === "agent" ? `RFN-A-${hex}` : `RFN-C-${hex}`;
}
let schemaReady = false;
async function ensureReferralSchema(pool = getPool()) {
  if (schemaReady) return;
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS referral_codes (
        id CHAR(36) NOT NULL PRIMARY KEY,
        owner_user_id CHAR(36) NOT NULL,
        owner_role VARCHAR(32) NOT NULL,
        program VARCHAR(16) NOT NULL,
        code VARCHAR(64) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_referral_codes_code UNIQUE (code),
        CONSTRAINT uq_referral_codes_owner_program UNIQUE (owner_user_id, program)
      )
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS referral_invites (
        id CHAR(36) NOT NULL PRIMARY KEY,
        referral_code_id CHAR(36) NOT NULL,
        referrer_user_id CHAR(36) NOT NULL,
        program VARCHAR(16) NOT NULL,
        referred_name VARCHAR(255) NULL,
        referred_email VARCHAR(255) NULL,
        referred_phone VARCHAR(32) NULL,
        channel VARCHAR(32) NULL,
        lead_id CHAR(36) NULL,
        converted_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    try {
      await pool.execute(`ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS referral_code VARCHAR(64) NULL`);
      await pool.execute(`ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS referral_program VARCHAR(16) NULL`);
      await pool.execute(`ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS referred_by_user_id CHAR(36) NULL`);
    } catch (err) {
      if (!isDuplicateColumnError(err) && !isIgnorableMigrationError(err)) throw err;
    }
    schemaReady = true;
  } catch (err) {
    if (isIgnorableMigrationError(err)) {
      schemaReady = true;
      return;
    }
    throw err;
  }
}
function mapCodeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    ownerRole: row.owner_role,
    program: row.program,
    code: row.code,
    createdAt: row.created_at
  };
}
async function insertReferralCode(pool, { ownerUserId, ownerRole, program, code }) {
  const id = newId();
  await pool.execute(
    `INSERT INTO referral_codes (id, owner_user_id, owner_role, program, code)
     VALUES (:id, :owner_user_id, :owner_role, :program, ${sqlCastParam("code")})`,
    {
      id,
      owner_user_id: ownerUserId,
      owner_role: ownerRole,
      program,
      code
    }
  );
  return { id, ownerUserId, ownerRole, program, code };
}
async function findCodeRow(pool, code) {
  const normalized = normalizeReferralCode(code);
  if (!normalized) return null;
  const [[row]] = await pool.execute(
    `SELECT * FROM referral_codes WHERE UPPER(code) = :code LIMIT 1`,
    { code: normalized }
  );
  return mapCodeRow(row);
}
async function resolveReferralCode(pool, rawCode) {
  await ensureReferralSchema(pool);
  const code = normalizeReferralCode(rawCode);
  if (!code) return null;
  const existing = await findCodeRow(pool, code);
  if (existing) return existing;
  const [[agent]] = await pool.execute(
    `SELECT ao.user_id, ao.agent_code, up.role
     FROM agent_onboarding ao
     JOIN user_profiles up ON up.id = ao.user_id
     WHERE UPPER(TRIM(CAST(ao.agent_code AS TEXT))) = :code
     LIMIT 1`,
    { code }
  );
  if (agent?.user_id) {
    return {
      id: null,
      ownerUserId: agent.user_id,
      ownerRole: agent.role || "agent",
      program: "customer",
      code: agent.agent_code,
      legacy: true
    };
  }
  const [[customer]] = await pool.execute(
    `SELECT id, role, customer_code
     FROM user_profiles
     WHERE UPPER(TRIM(CAST(customer_code AS TEXT))) = :code
     LIMIT 1`,
    { code }
  );
  if (customer?.id) {
    return {
      id: null,
      ownerUserId: customer.id,
      ownerRole: customer.role || "customer",
      program: "customer",
      code: customer.customer_code,
      legacy: true
    };
  }
  return null;
}
async function ensureReferralCodeForUser(pool, { userId, role, program }) {
  await ensureReferralSchema(pool);
  const normalizedProgram = normalizeReferralProgram(program);
  if (!userId || !normalizedProgram) return null;
  const [[existing]] = await pool.execute(
    `SELECT * FROM referral_codes
     WHERE owner_user_id = :user_id AND program = :program
     LIMIT 1`,
    { user_id: userId, program: normalizedProgram }
  );
  if (existing) return mapCodeRow(existing);
  if (normalizedProgram === "customer" && role === "agent") {
    const agentCode = await ensureAgentCodeForUser(pool, userId);
    if (agentCode) {
      try {
        return await insertReferralCode(pool, {
          ownerUserId: userId,
          ownerRole: "agent",
          program: "customer",
          code: String(agentCode).trim().toUpperCase()
        });
      } catch {
        const again = await findCodeRow(pool, agentCode);
        if (again) return again;
      }
    }
  }
  if (normalizedProgram === "customer" && role === "customer") {
    const customerCode = await assignUniqueCustomerCode(pool, userId);
    if (customerCode) {
      try {
        return await insertReferralCode(pool, {
          ownerUserId: userId,
          ownerRole: "customer",
          program: "customer",
          code: String(customerCode).trim().toUpperCase()
        });
      } catch {
        const again = await findCodeRow(pool, customerCode);
        if (again) return again;
      }
    }
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = generateProgramCode(normalizedProgram);
    try {
      return await insertReferralCode(pool, {
        ownerUserId: userId,
        ownerRole: role || "customer",
        program: normalizedProgram,
        code
      });
    } catch {
      const collision = await findCodeRow(pool, code);
      if (collision && collision.ownerUserId === userId) return collision;
    }
  }
  throw new Error("Could not allocate a unique referral code");
}
function publicAppBase() {
  return process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || "https://rfincare.com";
}
function buildReferralShareLinks(code, program) {
  const base = publicAppBase().replace(/\/$/, "");
  const encoded = encodeURIComponent(code);
  if (program === "agent") {
    return {
      homepage: `${base}/?aref=${encoded}`,
      partnerLogin: `${base}/agent-login?aref=${encoded}`
    };
  }
  return {
    homepage: `${base}/?ref=${encoded}`,
    insurance: `${base}/insurance-marketplace?ref=${encoded}`,
    mutualFunds: `${base}/mutual-fund-marketplace?ref=${encoded}`,
    calculators: `${base}/resources/calculators?ref=${encoded}`
  };
}
async function applyReferralToLead(pool, leadId, body = {}) {
  if (!leadId) return null;
  await ensureReferralSchema(pool);
  const programHint = normalizeReferralProgram(body.referralProgram || body.referral_program);
  const rawCode = body.referralCode || body.referral_code || (programHint === "agent" ? null : body.sourcedAgentCode || body.sourced_agent_code || body.agentCode);
  const resolved = await resolveReferralCode(pool, rawCode);
  if (!resolved) {
    const agentCode = normalizeReferralCode(body.sourcedAgentCode || body.sourced_agent_code || body.agentCode);
    if (!agentCode) return null;
    try {
      await pool.execute(
        `UPDATE marketing_leads SET sourced_agent_code = :code WHERE id = :id`,
        { code: agentCode, id: leadId }
      );
    } catch {
    }
    return { referralCode: agentCode, referralProgram: "customer" };
  }
  const program = programHint || resolved.program || "customer";
  const sourcedAgentCode = program === "customer" && resolved.ownerRole === "agent" ? resolved.code : null;
  try {
    await pool.execute(
      `UPDATE marketing_leads SET
         referral_code = :referral_code,
         referral_program = :referral_program,
         referred_by_user_id = :referred_by,
         sourced_agent_code = COALESCE(:sourced_agent_code, sourced_agent_code)
       WHERE id = :id`,
      {
        id: leadId,
        referral_code: resolved.code,
        referral_program: program,
        referred_by: resolved.ownerUserId,
        sourced_agent_code: sourcedAgentCode
      }
    );
  } catch {
    if (sourcedAgentCode) {
      try {
        await pool.execute(
          `UPDATE marketing_leads SET sourced_agent_code = :code WHERE id = :id`,
          { code: sourcedAgentCode, id: leadId }
        );
      } catch {
      }
    }
  }
  if (resolved.id) {
    await pool.execute(
      `UPDATE referral_invites
       SET lead_id = COALESCE(lead_id, :lead_id), converted_at = COALESCE(converted_at, NOW())
       WHERE referral_code_id = :code_id
         AND lead_id IS NULL
         AND (
           (:email <> '' AND LOWER(COALESCE(referred_email, '')) = :email)
           OR (:phone <> '' AND referred_phone = :phone)
         )`,
      {
        lead_id: leadId,
        code_id: resolved.id,
        email: String(body.email || "").trim().toLowerCase(),
        phone: String(body.phone || "").replace(/\D/g, "").slice(-10)
      }
    ).catch(() => {
    });
  }
  return {
    referralCode: resolved.code,
    referralProgram: program,
    referredByUserId: resolved.ownerUserId,
    sourcedAgentCode
  };
}
async function createReferralInvite(pool, {
  referrerUserId,
  referrerRole,
  program,
  referredName,
  referredEmail,
  referredPhone,
  channel
}) {
  const row = await ensureReferralCodeForUser(pool, {
    userId: referrerUserId,
    role: referrerRole,
    program
  });
  if (!row?.id) throw new Error("Referral code is not ready");
  const id = newId();
  await pool.execute(
    `INSERT INTO referral_invites (
       id, referral_code_id, referrer_user_id, program,
       referred_name, referred_email, referred_phone, channel
     ) VALUES (
       :id, :referral_code_id, :referrer_user_id, :program,
       :referred_name, :referred_email, :referred_phone, :channel
     )`,
    {
      id,
      referral_code_id: row.id,
      referrer_user_id: referrerUserId,
      program: row.program,
      referred_name: referredName || null,
      referred_email: referredEmail || null,
      referred_phone: referredPhone || null,
      channel: channel || null
    }
  );
  return { id, referralCode: row.code, program: row.program };
}
async function listReferralInvites(pool, { referrerUserId, program }) {
  const conditions = ["ri.referrer_user_id = :user_id"];
  const params = { user_id: referrerUserId };
  if (program) {
    conditions.push("ri.program = :program");
    params.program = program;
  }
  const [rows] = await pool.execute(
    `SELECT ri.*, rc.code AS referral_code
     FROM referral_invites ri
     LEFT JOIN referral_codes rc ON rc.id = ri.referral_code_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY ri.created_at DESC
     LIMIT 50`,
    params
  );
  return rows.map((row) => ({
    id: row.id,
    referralCode: row.referral_code,
    program: row.program,
    referredName: row.referred_name,
    referredEmail: row.referred_email,
    referredPhone: row.referred_phone,
    channel: row.channel,
    leadId: row.lead_id,
    convertedAt: row.converted_at,
    createdAt: row.created_at
  }));
}
async function countAttributedReferrals(pool, { referrerUserId, program }) {
  const [[row]] = await pool.execute(
    program ? `SELECT COUNT(*)::int AS c
         FROM marketing_leads
         WHERE referred_by_user_id = :user_id
           AND referral_program = :program` : `SELECT COUNT(*)::int AS c
         FROM marketing_leads
         WHERE referred_by_user_id = :user_id`,
    program ? { user_id: referrerUserId, program } : { user_id: referrerUserId }
  );
  return Number(row?.c || 0);
}
async function recordReferralConversion(pool, {
  referralCode,
  program = "agent",
  referredName,
  referredEmail,
  referredPhone,
  channel = "conversion"
}) {
  const resolved = await resolveReferralCode(pool, referralCode);
  if (!resolved?.ownerUserId) return null;
  const persisted = resolved.id ? resolved : await ensureReferralCodeForUser(pool, {
    userId: resolved.ownerUserId,
    role: resolved.ownerRole,
    program: program || resolved.program
  });
  if (!persisted?.id) return resolved;
  const id = newId();
  try {
    await pool.execute(
      `INSERT INTO referral_invites (
         id, referral_code_id, referrer_user_id, program,
         referred_name, referred_email, referred_phone, channel, converted_at
       ) VALUES (
         :id, :referral_code_id, :referrer_user_id, :program,
         :referred_name, :referred_email, :referred_phone, :channel, NOW()
       )`,
      {
        id,
        referral_code_id: persisted.id,
        referrer_user_id: persisted.ownerUserId,
        program: program || persisted.program,
        referred_name: referredName || null,
        referred_email: referredEmail || null,
        referred_phone: referredPhone || null,
        channel
      }
    );
  } catch {
    return persisted;
  }
  return { ...persisted, inviteId: id };
}
export {
  applyReferralToLead,
  buildReferralShareLinks,
  countAttributedReferrals,
  createReferralInvite,
  ensureReferralCodeForUser,
  ensureReferralSchema,
  listReferralInvites,
  normalizeReferralCode,
  normalizeReferralProgram,
  recordReferralConversion,
  resolveReferralCode
};
