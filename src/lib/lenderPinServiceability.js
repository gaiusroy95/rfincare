/**
 * Bank / product PIN serviceability for eligibility.
 * Upload lives in Geo hierarchy (one Excel per bank); engine consumes it here.
 */

export const LOCATION_MAPPED_REMARK = 'location is mapped';
export const LOCATION_NOT_COVERED_REMARK = 'location not covered by bank';

export function normalizeApplicationPincode(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length < 6) return null;
  return digits.slice(0, 6);
}

/**
 * Pick the best matching serviceability row for a bank (+ optional product).
 * Preference: product-specific row → bank-level row (null product).
 */
export function pickServiceabilityRow(rows, { bankId, bankProductId = null } = {}) {
  const forBank = (rows || []).filter((r) => r.bank_id === bankId || r.bankId === bankId);
  if (!forBank.length) return null;

  if (bankProductId) {
    const productRow = forBank.find(
      (r) => (r.bank_product_id || r.bankProductId) === bankProductId,
    );
    if (productRow) return productRow;
  }

  return (
    forBank.find((r) => !(r.bank_product_id || r.bankProductId)) ||
    forBank[0] ||
    null
  );
}

/**
 * Apply location gate after FOIR / LTV / policy scoring.
 *
 * @param {object} opts
 * @param {string|null} opts.pincode - normalized 6-digit PIN (or null = skip gate)
 * @param {boolean} opts.bankHasCoverageList - bank uploaded at least one PIN row
 * @param {object|null} opts.row - matching lender_serviceability row for this PIN
 * @param {string} opts.decision - current ELIGIBLE | CONDITIONAL | NOT_ELIGIBLE
 * @param {string} opts.decisionReason - current reason
 * @param {number} opts.probability
 * @param {number} opts.eligibleAmount
 */
export function applyLocationServiceabilityGate({
  pincode,
  bankHasCoverageList,
  row,
  decision,
  decisionReason,
  probability,
  eligibleAmount,
}) {
  // No applicant PIN → do not invent a location decision
  if (!pincode) {
    return {
      locationStatus: 'skipped',
      locationRemark: null,
      decision,
      decisionReason,
      probability,
      eligibleAmount,
      locationCovered: null,
    };
  }

  // Bank has not uploaded any PIN list → fail-open (FOIR/LTV still apply)
  if (!bankHasCoverageList) {
    return {
      locationStatus: 'no_coverage_list',
      locationRemark: null,
      decision,
      decisionReason,
      probability,
      eligibleAmount,
      locationCovered: null,
    };
  }

  const status = String(row?.status || '').toLowerCase().replace(/\s+/g, '_');
  const covered = status === 'serviceable' || status === 'restricted';

  if (covered) {
    const extra =
      status === 'restricted'
        ? `${LOCATION_MAPPED_REMARK} (restricted)`
        : LOCATION_MAPPED_REMARK;
    const reasonParts = [decisionReason, extra].filter(Boolean);
    return {
      locationStatus: status,
      locationRemark: extra,
      decision,
      decisionReason: reasonParts.join(' · '),
      probability,
      eligibleAmount,
      locationCovered: true,
    };
  }

  // Missing PIN on list, or explicitly not_serviceable
  return {
    locationStatus: status || 'missing',
    locationRemark: LOCATION_NOT_COVERED_REMARK,
    decision: 'NOT_ELIGIBLE',
    decisionReason: LOCATION_NOT_COVERED_REMARK,
    probability: 0,
    eligibleAmount: 0,
    locationCovered: false,
  };
}
