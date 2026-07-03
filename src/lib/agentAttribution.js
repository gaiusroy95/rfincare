/**
 * Resolve agent referral codes to agent user ids for attribution.
 */

export async function resolveAgentByCode(pool, agentCode) {
  if (!agentCode) return null;
  const code = String(agentCode).trim().toUpperCase();
  if (!code) return null;

  const [[row]] = await pool.execute(
    `SELECT up.id, up.full_name, up.email, ao.agent_code
     FROM agent_onboarding ao
     JOIN user_profiles up ON up.id = ao.user_id
     WHERE UPPER(ao.agent_code) = :code AND up.role = 'agent'
     LIMIT 1`,
    { code },
  );
  if (!row) return null;
  return {
    userId: row.id,
    fullName: row.full_name,
    email: row.email,
    agentCode: row.agent_code,
  };
}

export function normalizeAgentCode(value) {
  if (!value) return null;
  const code = String(value).trim().toUpperCase();
  return code || null;
}
