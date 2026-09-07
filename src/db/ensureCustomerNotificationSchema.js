import { getPool } from './pool.js';

let ensured = false;

/** Persist notification type / deep-link / payload for in-app alert clicks. */
export async function ensureCustomerNotificationSchema() {
  if (ensured) return;
  const pool = getPool();
  await pool.execute(`
    ALTER TABLE customer_notifications
      ADD COLUMN IF NOT EXISTS notification_type VARCHAR(64) NULL,
      ADD COLUMN IF NOT EXISTS action_path VARCHAR(512) NULL,
      ADD COLUMN IF NOT EXISTS data_json JSONB NULL
  `);
  ensured = true;
}
