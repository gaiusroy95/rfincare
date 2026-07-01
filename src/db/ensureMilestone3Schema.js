import { getPool } from './pool.js';
import { isIgnorableEnsureError } from './schemaErrors.js';

let ensured = false;

/** Repair interest_matrix_rates.bank_id when legacy MySQL migration 020 did not apply on PostgreSQL. */
export async function ensureMilestone3Schema() {
  if (ensured) return;

  const pool = getPool();
  const client = pool._pgPool || pool;

  try {
    await client.query(`
      ALTER TABLE interest_matrix_rates
      ADD COLUMN IF NOT EXISTS bank_id CHAR(36) NULL
    `);
  } catch (err) {
    if (!isIgnorableEnsureError(err)) throw err;
  }

  try {
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_interest_matrix_bank ON interest_matrix_rates (bank_id)
    `);
  } catch (err) {
    if (!isIgnorableEnsureError(err)) throw err;
  }

  ensured = true;
}
