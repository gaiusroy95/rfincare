/**
 * Public forgot-password helpers: masking, role gates, simple rate limiting.
 */

const OTP_WINDOW_MS = 15 * 60 * 1000;
const OTP_MAX_PER_WINDOW = 5;
const CONFIRM_MAX_ATTEMPTS = 8;

/** @type {Map<string, number[]>} */
const requestHits = new Map();
/** @type {Map<string, { count: number, resetAt: number }>} */
const confirmHits = new Map();

const PORTAL_ROLES = {
  customer: new Set(['customer']),
  agent: new Set(['agent']),
  employee: new Set(['employee']),
  admin: new Set(['admin', 'super_admin']),
};

export function normalizeForgotEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function normalizeForgotPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

export function maskEmail(email) {
  const value = normalizeForgotEmail(email);
  const [local, domain] = value.split('@');
  if (!local || !domain) return '***';
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}

export function maskPhone(phone) {
  const digits = normalizeForgotPhone(phone);
  if (digits.length !== 10) return null;
  return `******${digits.slice(-4)}`;
}

export function portalAllowsRole(portal, role) {
  if (!portal) return true;
  const allowed = PORTAL_ROLES[String(portal).toLowerCase()];
  if (!allowed) return true;
  return allowed.has(String(role || '').toLowerCase());
}

export function assertPasswordStrength(password) {
  const value = String(password || '');
  if (value.length < 8) {
    const err = new Error('Password must be at least 8 characters');
    err.status = 400;
    throw err;
  }
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    const err = new Error('Password must include at least one letter and one number');
    err.status = 400;
    throw err;
  }
}

function pruneHits(list, now) {
  return (list || []).filter((ts) => now - ts < OTP_WINDOW_MS);
}

export function assertForgotRequestAllowed(email) {
  const key = normalizeForgotEmail(email);
  const now = Date.now();
  const next = pruneHits(requestHits.get(key), now);
  if (next.length >= OTP_MAX_PER_WINDOW) {
    const err = new Error('Too many OTP requests. Please wait a few minutes and try again.');
    err.status = 429;
    throw err;
  }
  next.push(now);
  requestHits.set(key, next);
}

export function assertForgotConfirmAllowed(email) {
  const key = normalizeForgotEmail(email);
  const now = Date.now();
  const current = confirmHits.get(key);
  if (current && current.resetAt > now && current.count >= CONFIRM_MAX_ATTEMPTS) {
    const err = new Error('Too many verification attempts. Please request a new OTP.');
    err.status = 429;
    throw err;
  }
  if (!current || current.resetAt <= now) {
    confirmHits.set(key, { count: 1, resetAt: now + OTP_WINDOW_MS });
    return;
  }
  current.count += 1;
  confirmHits.set(key, current);
}

export function clearForgotConfirmAttempts(email) {
  confirmHits.delete(normalizeForgotEmail(email));
}

export function buildForgotChannels({ email, phone }) {
  const channels = [
    {
      id: 'email',
      label: 'Email',
      description: 'Send OTP to registered email',
      masked: maskEmail(email),
    },
  ];
  const maskedMobile = maskPhone(phone);
  if (maskedMobile) {
    channels.push({
      id: 'sms',
      label: 'Mobile SMS',
      description: 'Send OTP to registered mobile number',
      masked: maskedMobile,
    });
    channels.push({
      id: 'whatsapp',
      label: 'WhatsApp',
      description: 'Send OTP via WhatsApp on registered mobile',
      masked: maskedMobile,
    });
  }
  return channels;
}
