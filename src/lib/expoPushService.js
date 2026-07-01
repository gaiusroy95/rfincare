import { getPool } from '../db/pool.js';
import { newId } from './ids.js';
import { ensurePushNotificationSchema } from '../db/ensurePushNotificationSchema.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

const DEFAULT_PREFS = { push: true, email: true, sms: true, marketing: false };

export async function getUserNotificationPreferences(userId) {
  await ensurePushNotificationSchema();
  const pool = getPool();
  try {
    const [[row]] = await pool.execute(
      `SELECT notification_preferences FROM user_profiles WHERE id = :id LIMIT 1`,
      { id: userId },
    );
    if (!row?.notification_preferences) return { ...DEFAULT_PREFS };
    const raw =
      typeof row.notification_preferences === 'string'
        ? JSON.parse(row.notification_preferences)
        : row.notification_preferences;
    return { ...DEFAULT_PREFS, ...(raw || {}) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export async function saveUserNotificationPreferences(userId, preferences) {
  await ensurePushNotificationSchema();
  const pool = getPool();
  const current = await getUserNotificationPreferences(userId);
  const merged = { ...current, ...(preferences || {}) };
  await pool.execute(
    `UPDATE user_profiles SET notification_preferences = :prefs WHERE id = :id`,
    { id: userId, prefs: JSON.stringify(merged) },
  );
  return merged;
}

export async function registerPushToken({
  userId,
  role,
  expoPushToken,
  platform = null,
  appVariant = 'customer',
}) {
  if (!expoPushToken || !userId) return null;
  await ensurePushNotificationSchema();
  const pool = getPool();
  const id = newId();
  await pool.execute(
    `INSERT INTO push_device_tokens (
       id, user_id, role, expo_push_token, platform, app_variant, is_active, updated_at
     ) VALUES (
       :id, :uid, :role, :token, :platform, :variant, 1, NOW()
     ) ON CONFLICT (expo_push_token) DO UPDATE SET user_id = EXCLUDED.user_id,
       role = EXCLUDED.role,
       platform = EXCLUDED.platform,
       app_variant = EXCLUDED.app_variant,
       is_active = TRUE,
       updated_at = NOW()`,
    {
      id,
      uid: userId,
      role,
      token: expoPushToken,
      platform,
      variant: appVariant,
    },
  );
  return expoPushToken;
}

export async function unregisterPushToken(expoPushToken) {
  if (!expoPushToken) return;
  await ensurePushNotificationSchema();
  const pool = getPool();
  await pool.execute(
    `UPDATE push_device_tokens SET is_active = FALSE, updated_at = NOW() WHERE expo_push_token = :token`,
    { token: expoPushToken },
  );
}

export async function sendExpoPushToUser(userId, { title, body, data = {} }) {
  const prefs = await getUserNotificationPreferences(userId);
  if (prefs.push === false) return { skipped: true, reason: 'push_disabled' };

  await ensurePushNotificationSchema();
  const pool = getPool();
  const [tokens] = await pool.execute(
    `SELECT expo_push_token FROM push_device_tokens WHERE user_id = :uid AND is_active = TRUE`,
    { uid: userId },
  );
  if (!tokens.length) return { skipped: true, reason: 'no_tokens' };

  const messages = tokens.map((row) => ({
    to: row.expo_push_token,
    sound: 'default',
    title: String(title || 'Rfincare'),
    body: String(body || ''),
    data: data || {},
    priority: 'high',
    channelId: 'rfincare-updates',
  }));

  const results = [];
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(chunk),
      });
      results.push(await res.json());
    } catch (err) {
      results.push({ error: err.message });
    }
  }

  return { sent: tokens.length, results };
}