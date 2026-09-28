/**
 * OTP abuse protection: resend cooldown, hourly send cap, and wrong-code lockout.
 * State is in-process memory, so limits are per API instance (reset on restart).
 */

const SEND_COOLDOWN_MS = Number(process.env.OTP_RESEND_COOLDOWN_SECONDS || 30) * 1000;
const SEND_WINDOW_MS = 60 * 60 * 1000;
const SEND_MAX_PER_WINDOW = Number(process.env.OTP_MAX_SENDS_PER_HOUR || 8);
const VERIFY_MAX_FAILURES = Number(process.env.OTP_MAX_VERIFY_ATTEMPTS || 5);
const VERIFY_LOCK_MS = Number(process.env.OTP_VERIFY_LOCK_MINUTES || 15) * 60 * 1000;
const MAX_TRACKED_KEYS = 20000;

const sendLog = new Map();
const verifyFailures = new Map();

/** Render sets RENDER=true, Cloud Run sets K_SERVICE, Vercel sets VERCEL. */
export function isProductionRuntime() {
  return (
    process.env.NODE_ENV === 'production'
    || process.env.RENDER === 'true'
    || Boolean(process.env.K_SERVICE)
    || process.env.VERCEL === '1'
  );
}

/** Returning the OTP in API responses (and the 123456 bypass) is local-dev only. */
export function canExposeDevOtp() {
  return process.env.LOG_OTP === 'true' && !isProductionRuntime();
}

export function otpTargetKeys({ phone, email } = {}) {
  const keys = [];
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length >= 10) keys.push(`phone:${digits.slice(-10)}`);
  const mail = String(email || '').trim().toLowerCase();
  if (mail) keys.push(`email:${mail}`);
  return keys;
}

function tooManyRequests(message, retryAfterSeconds) {
  const err = new Error(message);
  err.status = 429;
  err.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  return err;
}

function trim(map) {
  if (map.size <= MAX_TRACKED_KEYS) return;
  const overflow = map.size - MAX_TRACKED_KEYS;
  let removed = 0;
  for (const key of map.keys()) {
    map.delete(key);
    removed += 1;
    if (removed >= overflow) break;
  }
}

function recentSends(key, now) {
  const stamps = (sendLog.get(key) || []).filter((t) => now - t < SEND_WINDOW_MS);
  if (stamps.length) sendLog.set(key, stamps);
  else sendLog.delete(key);
  return stamps;
}

export function assertOtpSendAllowed(keys = []) {
  const now = Date.now();
  for (const key of keys) {
    const stamps = recentSends(key, now);
    const last = stamps[stamps.length - 1];
    if (last && now - last < SEND_COOLDOWN_MS) {
      const wait = (SEND_COOLDOWN_MS - (now - last)) / 1000;
      throw tooManyRequests(
        `Please wait ${Math.ceil(wait)} seconds before requesting another OTP.`,
        wait,
      );
    }
    if (stamps.length >= SEND_MAX_PER_WINDOW) {
      const wait = (SEND_WINDOW_MS - (now - stamps[0])) / 1000;
      throw tooManyRequests(
        `Too many OTP requests. Please try again in ${Math.ceil(wait / 60)} minutes.`,
        wait,
      );
    }
  }
}

export function recordOtpSent(keys = []) {
  const now = Date.now();
  for (const key of keys) {
    const stamps = recentSends(key, now);
    stamps.push(now);
    sendLog.set(key, stamps);
  }
  trim(sendLog);
}

export function assertOtpVerifyAllowed(keys = []) {
  const now = Date.now();
  for (const key of keys) {
    const entry = verifyFailures.get(key);
    if (!entry) continue;
    if (entry.lockedUntil && entry.lockedUntil > now) {
      const wait = (entry.lockedUntil - now) / 1000;
      throw tooManyRequests(
        `Too many incorrect OTP attempts. Please try again in ${Math.ceil(wait / 60)} minutes.`,
        wait,
      );
    }
    if (entry.lockedUntil && entry.lockedUntil <= now) verifyFailures.delete(key);
  }
}

/** Returns the number of attempts left before lockout. */
export function recordOtpVerifyFailure(keys = []) {
  const now = Date.now();
  let remaining = VERIFY_MAX_FAILURES;
  for (const key of keys) {
    const entry = verifyFailures.get(key) || { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= VERIFY_MAX_FAILURES) {
      entry.lockedUntil = now + VERIFY_LOCK_MS;
    }
    verifyFailures.set(key, entry);
    remaining = Math.min(remaining, Math.max(0, VERIFY_MAX_FAILURES - entry.count));
  }
  trim(verifyFailures);
  return remaining;
}

export function clearOtpVerifyFailures(keys = []) {
  for (const key of keys) verifyFailures.delete(key);
}

/** Records a failure and returns a user-facing message (for handlers that return `{ ok: false }`). */
export function failedOtpMessage(keys = [], message = 'Invalid or expired OTP.') {
  const remaining = recordOtpVerifyFailure(keys);
  if (remaining <= 0) {
    return 'Too many incorrect OTP attempts. Please request a new OTP after some time.';
  }
  return `${message} ${remaining} attempt${remaining === 1 ? '' : 's'} left.`;
}

/** Standard 401 for a wrong/expired code, including attempts left. */
export function invalidOtpError(keys = [], message = 'Invalid or expired OTP') {
  const remaining = recordOtpVerifyFailure(keys);
  const err = remaining > 0
    ? new Error(`${message}. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`)
    : new Error('Too many incorrect OTP attempts. Please request a new OTP after some time.');
  err.status = remaining > 0 ? 401 : 429;
  if (remaining === 0) err.retryAfterSeconds = Math.ceil(VERIFY_LOCK_MS / 1000);
  return err;
}

export function otpSecurityLimits() {
  return {
    resendCooldownSeconds: Math.round(SEND_COOLDOWN_MS / 1000),
    maxSendsPerHour: SEND_MAX_PER_WINDOW,
    maxVerifyAttempts: VERIFY_MAX_FAILURES,
  };
}
