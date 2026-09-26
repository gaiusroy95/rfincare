import jwt from 'jsonwebtoken';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export function signAccessToken({ userId, role, email, applicationId }) {
  const secret = requireEnv('JWT_ACCESS_SECRET');
  // Applicant onboarding tokens are longer-lived (no refresh_tokens row without auth_users).
  const defaultTtl = role === 'agent_applicant'
    ? Number(process.env.JWT_APPLICANT_ACCESS_TTL_SECONDS || 60 * 60 * 24 * 7)
    : Number(process.env.JWT_ACCESS_TTL_SECONDS || 900);
  const ttl = defaultTtl;
  const payload = { sub: userId, role, email, typ: 'access' };
  if (applicationId) payload.applicationId = applicationId;
  return jwt.sign(payload, secret, { expiresIn: ttl });
}

export function signRefreshToken({ tokenId, userId }) {
  const secret = requireEnv('JWT_REFRESH_SECRET');
  const ttl = Number(process.env.JWT_REFRESH_TTL_SECONDS || 60 * 60 * 24 * 30);
  return jwt.sign(
    { sub: userId, jti: tokenId, typ: 'refresh' },
    secret,
    { expiresIn: ttl },
  );
}

export function verifyAccessToken(token) {
  const secret = requireEnv('JWT_ACCESS_SECRET');
  const payload = jwt.verify(token, secret);
  if (payload?.typ !== 'access') throw new Error('Invalid token type');
  return payload;
}

export function verifyRefreshToken(token) {
  const secret = requireEnv('JWT_REFRESH_SECRET');
  const payload = jwt.verify(token, secret);
  if (payload?.typ !== 'refresh') throw new Error('Invalid token type');
  return payload;
}

