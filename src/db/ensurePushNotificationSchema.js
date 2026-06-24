import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPool } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let ensured = false;

async function tryAlter(sql) {
  const pool = getPool();
  try {
    await pool.execute(sql);
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }
}

export async function ensurePushNotificationSchema() {
  if (ensured) return;
  const pool = getPool();
  const sql = readFileSync(join(__dirname, '../../migrations/031_push_notifications.sql'), 'utf8');
  await pool.execute(sql.trim());
  await tryAlter(`ALTER TABLE user_profiles ADD COLUMN notification_preferences JSON NULL`);
  ensured = true;
}
