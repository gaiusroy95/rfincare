import { getPool } from './pool.js';
import { isIgnorableEnsureError } from './schemaErrors.js';

let ensured = false;

/** Ensure employee_profile_otps exists (migration 040 may not have run on older databases). */
export async function ensureEmployeeProfileSchema() {
  if (ensured) return;

  const pool = getPool();
  const client = pool._pgPool || pool;

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS employee_profile_otps (
        id CHAR(36) NOT NULL,
        employee_user_id CHAR(36) NOT NULL,
        purpose VARCHAR(48) NOT NULL,
        channel VARCHAR(16) NOT NULL,
        target_email VARCHAR(320) NULL,
        target_phone VARCHAR(32) NULL,
        otp_hash VARCHAR(64) NOT NULL,
        payload JSON NULL,
        verified_at TIMESTAMPTZ NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
    `);
  } catch (err) {
    if (!isIgnorableEnsureError(err)) throw err;
  }

  try {
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_employee_profile_otps_user
      ON employee_profile_otps (employee_user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_employee_profile_otps_expires
      ON employee_profile_otps (expires_at)
    `);
  } catch (err) {
    if (!isIgnorableEnsureError(err)) throw err;
  }

  ensured = true;
}
