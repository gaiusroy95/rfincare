import { getPool } from './pool.js';

/** Schema is applied via npm run db:migrate; also ensure column for local/dev safety. */
export async function ensureAgentProfileSchema() {
  const pool = getPool();
  try {
    await pool.execute(
      `ALTER TABLE agent_onboarding ADD COLUMN IF NOT EXISTS account_proof_path TEXT NULL`,
    );
  } catch {
    /* older engines without IF NOT EXISTS — ignore */
  }
}
