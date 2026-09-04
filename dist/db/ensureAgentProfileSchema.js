import { getPool } from "./pool.js";
async function ensureAgentProfileSchema() {
  const pool = getPool();
  try {
    await pool.execute(
      `ALTER TABLE agent_onboarding ADD COLUMN IF NOT EXISTS account_proof_path TEXT NULL`
    );
  } catch {
  }
}
export {
  ensureAgentProfileSchema
};
