import { getPool } from './pool.js';

let ensured = false;

export async function ensureCreditCardSchema() {
  if (ensured) return;
  const pool = getPool();
  await pool.execute(`
    ALTER TABLE credit_cards
      ADD COLUMN IF NOT EXISTS reward_rules JSONB NULL,
      ADD COLUMN IF NOT EXISTS annual_fee_waiver_spend_threshold DECIMAL(14, 2) NULL
  `);
  ensured = true;
}
