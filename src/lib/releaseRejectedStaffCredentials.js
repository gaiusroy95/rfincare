import { sqlParamEqualsLower } from './sqlCollation.js';

/** Onboarding states where email/username may be reused for a new application. */
export const REJECTED_AGENT_ONBOARDING_STATUSES = new Set([
  'rejected',
  'suspended',
  'deactivated',
  'qc_rejected',
]);

function tombstoneLocalPart(value, userId, maxLen = 64) {
  const base = String(value || 'user').trim().toLowerCase().replace(/[^a-z0-9._+-@]/g, '');
  const suffix = `.released.${String(userId).slice(0, 8)}.${Date.now()}`;
  const trimmed = base.slice(0, Math.max(1, maxLen - suffix.length));
  return `${trimmed}${suffix}`;
}

function tombstoneEmail(email, userId) {
  const normalized = String(email || '').trim().toLowerCase();
  const at = normalized.indexOf('@');
  if (at <= 0) {
    return `${tombstoneLocalPart('released', userId, 48)}@archived.invalid`;
  }
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  return `${tombstoneLocalPart(local, userId)}@${domain}`;
}

function tombstoneUsername(username, userId) {
  return tombstoneLocalPart(username, userId, 128);
}

/**
 * Free unique email/username on rejected/suspended agent records so the same
 * credentials can be used for a new onboarding attempt.
 */
export async function releaseRejectedAgentCredentials(pool, { email, username }) {
  const normalizedEmail = email ? String(email).trim().toLowerCase() : null;
  const normalizedUsername = username ? String(username).trim() : null;
  if (!normalizedEmail && !normalizedUsername) return { released: 0 };

  const statusSql = [...REJECTED_AGENT_ONBOARDING_STATUSES]
    .map((s) => `'${s.replace(/'/g, "''")}'`)
    .join(', ');
  const conditions = [];
  const params = {};

  if (normalizedEmail) {
    conditions.push(`(${sqlParamEqualsLower('ao.email', 'email')}
      OR ${sqlParamEqualsLower('up.email', 'email')}
      OR ${sqlParamEqualsLower('au.email', 'email')})`);
    params.email = normalizedEmail;
  }
  if (normalizedUsername) {
    conditions.push(sqlParamEqualsLower('ao.username', 'username'));
    params.username = normalizedUsername;
  }

  const [rows] = await pool.execute(
    `SELECT DISTINCT ao.user_id, ao.email, ao.username, ao.onboarding_status,
            up.onboarding_status AS profile_onboarding_status
     FROM agent_onboarding ao
     JOIN user_profiles up ON up.id = ao.user_id
     JOIN auth_users au ON au.id = ao.user_id
     WHERE (${conditions.join(' OR ')})
       AND (
         LOWER(TRIM(CAST(ao.onboarding_status AS TEXT))) IN (${statusSql})
         OR LOWER(TRIM(CAST(up.onboarding_status AS TEXT))) IN (${statusSql})
       )`,
    params,
  );

  let released = 0;
  for (const row of rows || []) {
    const newEmail = tombstoneEmail(row.email, row.user_id);
    const newUsername = tombstoneUsername(row.username, row.user_id);

    await pool.execute(`UPDATE auth_users SET email = :email WHERE id = :id`, {
      email: newEmail,
      id: row.user_id,
    });
    await pool.execute(`UPDATE user_profiles SET email = :email WHERE id = :id`, {
      email: newEmail,
      id: row.user_id,
    });
    await pool.execute(
      `UPDATE agent_onboarding
       SET email = :email, username = :username, updated_at = NOW()
       WHERE user_id = :id`,
      { email: newEmail, username: newUsername, id: row.user_id },
    );
    released += 1;
  }

  return { released };
}
