const LOCATION_MAPPED_REMARK = "location is mapped";
const LOCATION_NOT_COVERED_REMARK = "location not covered by bank";
function normalizeApplicationPincode(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length < 6) return null;
  return digits.slice(0, 6);
}
function pickServiceabilityRow(rows, { bankId, bankProductId = null } = {}) {
  const forBank = (rows || []).filter((r) => r.bank_id === bankId || r.bankId === bankId);
  if (!forBank.length) return null;
  if (bankProductId) {
    const productRow = forBank.find(
      (r) => (r.bank_product_id || r.bankProductId) === bankProductId
    );
    if (productRow) return productRow;
  }
  return forBank.find((r) => !(r.bank_product_id || r.bankProductId)) || forBank[0] || null;
}
function applyLocationServiceabilityGate({
  pincode,
  bankHasCoverageList,
  row,
  decision,
  decisionReason,
  probability,
  eligibleAmount
}) {
  if (!pincode) {
    return {
      locationStatus: "skipped",
      locationRemark: null,
      decision,
      decisionReason,
      probability,
      eligibleAmount,
      locationCovered: null
    };
  }
  if (!bankHasCoverageList) {
    return {
      locationStatus: "no_coverage_list",
      locationRemark: null,
      decision,
      decisionReason,
      probability,
      eligibleAmount,
      locationCovered: null
    };
  }
  const status = String(row?.status || "").toLowerCase().replace(/\s+/g, "_");
  const covered = status === "serviceable" || status === "restricted";
  if (covered) {
    const extra = status === "restricted" ? `${LOCATION_MAPPED_REMARK} (restricted)` : LOCATION_MAPPED_REMARK;
    const reasonParts = [decisionReason, extra].filter(Boolean);
    return {
      locationStatus: status,
      locationRemark: extra,
      decision,
      decisionReason: reasonParts.join(" · "),
      probability,
      eligibleAmount,
      locationCovered: true
    };
  }
  return {
    locationStatus: status || "missing",
    locationRemark: LOCATION_NOT_COVERED_REMARK,
    decision: "NOT_ELIGIBLE",
    decisionReason: LOCATION_NOT_COVERED_REMARK,
    probability: 0,
    eligibleAmount: 0,
    locationCovered: false
  };
}
export {
  LOCATION_MAPPED_REMARK,
  LOCATION_NOT_COVERED_REMARK,
  applyLocationServiceabilityGate,
  normalizeApplicationPincode,
  pickServiceabilityRow
};
