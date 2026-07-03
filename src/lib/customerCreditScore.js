import { ensureMilestone4Schema } from '../db/ensureMilestone4Schema.js';
import { getPool } from '../db/pool.js';

function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function rangeToEstimate(range) {
  const map = {
    excellent: 780,
    good: 720,
    fair: 650,
    poor: 580,
    'below-600': 550,
    '600-700': 650,
    '700-750': 725,
    '750+': 780,
    '750-plus': 780,
  };
  const key = String(range || '').toLowerCase().replace(/\s+/g, '-');
  return map[key] ?? null;
}

/**
 * Best available credit score for a customer: bureau pull > application data > self-reported range.
 */
export async function getCustomerCreditProfile(customerId, email) {
  await ensureMilestone4Schema();
  const pool = getPool();

  let bureauScore = null;
  let bureauCheckedAt = null;
  let bureauVendor = null;

  try {
    const [[check]] = await pool.execute(
      `SELECT cc.credit_score, cc.checked_at, cc.status, cv.display_name AS vendor_name
       FROM cibil_checks cc
       LEFT JOIN cibil_vendors cv ON cv.vendor_key = cc.vendor_key
       WHERE cc.customer_id = :id AND cc.status = 'success' AND cc.credit_score IS NOT NULL
       ORDER BY cc.checked_at DESC
       LIMIT 1`,
      { id: customerId },
    );
    if (check?.credit_score) {
      bureauScore = Number(check.credit_score);
      bureauCheckedAt = check.checked_at;
      bureauVendor = check.vendor_name;
    }
  } catch {
    /* schema optional */
  }

  const [apps] = await pool.execute(
    `SELECT data, cibil_status, updated_at FROM loan_applications
     WHERE customer_id = :id ORDER BY updated_at DESC LIMIT 5`,
    { id: customerId },
  );

  let selfReportedRange = null;
  for (const app of apps || []) {
    const data = parseJson(app.data);
    const range = data.credit_score_range || data.creditScoreRange;
    if (range) {
      selfReportedRange = range;
      break;
    }
  }

  const estimatedFromRange = selfReportedRange ? rangeToEstimate(selfReportedRange) : null;
  const score = bureauScore ?? estimatedFromRange ?? null;
  const source = bureauScore ? 'bureau' : estimatedFromRange ? 'self_reported' : null;

  let band = 'unknown';
  if (score != null) {
    if (score >= 750) band = 'excellent';
    else if (score >= 700) band = 'good';
    else if (score >= 650) band = 'fair';
    else band = 'needs_improvement';
  }

  return {
    score,
    band,
    source,
    bureauScore,
    bureauCheckedAt,
    bureauVendor,
    selfReportedRange,
    hasBureauPull: bureauScore != null,
  };
}
