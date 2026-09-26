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

/**
 * Public website / eligibility: only stamp agent when request includes
 * explicit referral evidence (share link / referral program), not sticky
 * localStorage pollution from an agent who previously used the same browser.
 *
 * Direct website → { agentCode: null, source: 'direct' }
 * Agent referral URL → { agentCode, source: 'website_agent_referral' }
 */
export function resolvePublicWebsiteAttribution(input = {}) {
  const referralCode = String(input.referralCode || input.referral_code || '').trim().toUpperCase() || null;
  const program = String(input.referralProgram || input.referral_program || '').trim().toLowerCase();
  const referralId = input.referralId || input.referral_id || null;
  const sourced = normalizeAgentCode(
    input.sourcedAgentCode || input.sourced_agent_code || input.agentCode,
  );

  const looksLikeAgentCode = (code) =>
    Boolean(code) && (/^RFA([-\s]|$)/i.test(code) || /^RFN-A-/i.test(code));

  const isAgentReferral =
    program === 'agent'
    || looksLikeAgentCode(referralCode)
    || (Boolean(referralId) && (program === 'agent' || looksLikeAgentCode(sourced)))
    || (Boolean(referralCode) && sourced && normalizeAgentCode(referralCode) === sourced);

  if (!isAgentReferral) {
    return {
      agentCode: null,
      source: 'direct',
      referralCode: program === 'customer' ? referralCode : null,
      referralProgram: program === 'customer' ? 'customer' : null,
    };
  }

  return {
    agentCode: sourced || (looksLikeAgentCode(referralCode) ? normalizeAgentCode(referralCode) : null),
    source: 'website_agent_referral',
    referralCode,
    referralProgram: program === 'agent' || looksLikeAgentCode(referralCode) ? 'agent' : (program || 'agent'),
  };
}

/**
 * Strip forged agent stamps from unauthenticated website/eligibility lead bodies.
 * Authenticated agent/employee creates must not call this (or call after auth attach).
 */
export function sanitizeGuestLeadAttribution(body = {}) {
  const resolved = resolvePublicWebsiteAttribution(body);
  const next = { ...body };
  if (!resolved.agentCode) {
    next.sourcedAgentCode = null;
    next.sourced_agent_code = null;
    next.agentCode = null;
    const src = String(body.source || '').toLowerCase();
    if (!src || src === 'website' || src === 'website_agent_referral' || src === 'eligibility' || src === 'direct') {
      next.source = 'direct';
    }
  } else {
    next.sourcedAgentCode = resolved.agentCode;
    next.agentCode = resolved.agentCode;
    if (!next.source || next.source === 'website' || next.source === 'eligibility' || next.source === 'direct') {
      next.source = 'website_agent_referral';
    }
  }
  if (resolved.referralCode) next.referralCode = resolved.referralCode;
  if (resolved.referralProgram) next.referralProgram = resolved.referralProgram;
  return next;
}
