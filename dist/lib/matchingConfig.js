import { getPool } from "../db/pool.js";
import { ensurePolicyConsoleSchema } from "./policyConsole.js";
const DEFAULT_MATCHING_WEIGHTS = {
  income_mismatch: 25,
  credit_mismatch: 20,
  loan_amount_mismatch: 20,
  employment_mismatch: 15,
  loan_type_mismatch: 10,
  age_mismatch: 18,
  stability_mismatch: 10,
  emi_capacity_mismatch: 12,
  ltv_mismatch: 10,
  critical_fail_penalty: 100
};
const DEFAULT_DECISION_THRESHOLDS = {
  eligible_min_probability: 70,
  conditional_min_probability: 50
};
function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "object") return { ...fallback, ...value };
  try {
    return { ...fallback, ...JSON.parse(value) };
  } catch {
    return fallback;
  }
}
async function getMatchingConfig() {
  await ensurePolicyConsoleSchema();
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT * FROM matching_engine_config WHERE id = 'default' LIMIT 1`
  );
  if (!rows[0]) {
    return {
      id: "default",
      weights: { ...DEFAULT_MATCHING_WEIGHTS },
      decisionThresholds: { ...DEFAULT_DECISION_THRESHOLDS }
    };
  }
  return {
    id: rows[0].id,
    weights: parseJson(rows[0].weights_json, DEFAULT_MATCHING_WEIGHTS),
    decisionThresholds: parseJson(rows[0].decision_thresholds_json, DEFAULT_DECISION_THRESHOLDS),
    updatedBy: rows[0].updated_by,
    updatedAt: rows[0].updated_at
  };
}
async function saveMatchingConfig({ weights, decisionThresholds, actorId }) {
  await ensurePolicyConsoleSchema();
  const pool = getPool();
  const current = await getMatchingConfig();
  const nextWeights = { ...current.weights, ...weights || {} };
  const nextThresholds = { ...current.decisionThresholds, ...decisionThresholds || {} };
  await pool.execute(
    `INSERT INTO matching_engine_config (id, weights_json, decision_thresholds_json, updated_by, updated_at)
     VALUES ('default', :weights, :thresholds, :by, NOW())
     ON CONFLICT (id) DO UPDATE SET
       weights_json = EXCLUDED.weights_json,
       decision_thresholds_json = EXCLUDED.decision_thresholds_json,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    {
      weights: JSON.stringify(nextWeights),
      thresholds: JSON.stringify(nextThresholds),
      by: actorId || null
    }
  );
  return getMatchingConfig();
}
export {
  DEFAULT_DECISION_THRESHOLDS,
  DEFAULT_MATCHING_WEIGHTS,
  getMatchingConfig,
  saveMatchingConfig
};
