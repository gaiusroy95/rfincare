import { normalizeApplicationPincode } from "./lenderPinServiceability.js";
const GEO_MESSAGES = {
  covered: "Your application will get approved by below lenders as probability score shown.",
  inReview: "Your application is in review — our agent will connect with you shortly for more information to help you in checking your eligibility."
};
const COVERAGE_TYPES = /* @__PURE__ */ new Set([
  "INCLUDE",
  "EXCLUDE",
  "CONDITIONAL",
  "BRANCH_DEPENDENT"
]);
const PURCHASE_CONSTRUCTION = /purchase|construction|builder|under.?construction/i;
function isPurchaseOrConstructionPurpose(loanTypeOrPurpose) {
  return PURCHASE_CONSTRUCTION.test(String(loanTypeOrPurpose || ""));
}
function isSecuredLoanCategory(loanCategory) {
  return String(loanCategory || "").toLowerCase() === "secured";
}
function buildAddressPinChecks(input, { loanCategory } = {}) {
  const current = normalizeApplicationPincode(
    input.currentPincode || input.current_pin_code || input.residencePincode || input.pincode || input.pinCode || input.pin_code
  );
  const permanent = normalizeApplicationPincode(
    input.permanentPincode || input.permanent_pin_code || input.permanentPinCode
  );
  const property = normalizeApplicationPincode(
    input.propertyPincode || input.property_pin_code || input.propertyPinCode
  );
  const secured = isSecuredLoanCategory(loanCategory);
  const purchaseConstruction = isPurchaseOrConstructionPurpose(
    input.loanType || input.loanPurpose || input.loan_purpose
  );
  if (secured && purchaseConstruction) {
    return {
      mode: "secured_purchase_construction",
      pins: [
        { role: "current_work", pincode: current },
        { role: "property", pincode: property || permanent }
      ],
      requireAll: true
    };
  }
  if (secured) {
    return {
      mode: "secured_other",
      pins: [
        { role: "current_work", pincode: current },
        { role: "permanent", pincode: permanent || property }
      ],
      requireAll: true
    };
  }
  return {
    mode: "unsecured",
    pins: [
      { role: "current_residence", pincode: current },
      { role: "permanent", pincode: permanent }
    ],
    requireAll: false,
    fallbackReview: true
  };
}
function normalizeCoverageType(raw) {
  const t = String(raw || "INCLUDE").trim().toUpperCase().replace(/\s+/g, "_");
  if (t === "SERVICEABLE" || t === "INCLUDED" || t === "YES") return "INCLUDE";
  if (t === "NOT_SERVICEABLE" || t === "EXCLUDED" || t === "NO" || t === "NEGATIVE") return "EXCLUDE";
  if (t === "BRANCH" || t === "BRANCH-DEPENDENT") return "BRANCH_DEPENDENT";
  if (COVERAGE_TYPES.has(t)) return t;
  return "INCLUDE";
}
function matchBankGeoForPin(coverageRows, { pincode, districtName = null } = {}) {
  const rows = (coverageRows || []).map((r) => ({
    ...r,
    coverage_type: normalizeCoverageType(r.coverage_type || r.coverageType || r.status),
    pincode: normalizeApplicationPincode(r.pincode),
    district_name: String(r.district_name || r.districtName || "").trim().toLowerCase(),
    geo_level: String(r.geo_level || r.geoLevel || (r.pincode ? "pincode" : "district")).toLowerCase()
  }));
  if (!pincode) {
    return { matched: null, outcome: "no_pin", coverageType: null, matchedLevel: null };
  }
  const pinRows = rows.filter((r) => r.pincode === pincode);
  if (pinRows.length) {
    const exclude = pinRows.find((r) => r.coverage_type === "EXCLUDE");
    if (exclude) {
      return {
        matched: exclude,
        outcome: "excluded",
        coverageType: "EXCLUDE",
        matchedLevel: "pincode"
      };
    }
    const include = pinRows.find((r) => r.coverage_type === "INCLUDE");
    if (include) {
      return {
        matched: include,
        outcome: "covered",
        coverageType: "INCLUDE",
        matchedLevel: "pincode"
      };
    }
    const conditional = pinRows.find((r) => r.coverage_type === "CONDITIONAL");
    if (conditional) {
      return {
        matched: conditional,
        outcome: "conditional",
        coverageType: "CONDITIONAL",
        matchedLevel: "pincode"
      };
    }
    const branch = pinRows.find((r) => r.coverage_type === "BRANCH_DEPENDENT");
    if (branch) {
      return {
        matched: branch,
        outcome: "branch_dependent",
        coverageType: "BRANCH_DEPENDENT",
        matchedLevel: "pincode"
      };
    }
  }
  const distKey = String(districtName || "").trim().toLowerCase();
  if (distKey) {
    const districtRows = rows.filter(
      (r) => (r.geo_level === "district" || !r.pincode && r.district_name) && r.district_name === distKey
    );
    if (districtRows.length) {
      const exclude = districtRows.find((r) => r.coverage_type === "EXCLUDE");
      if (exclude) {
        return {
          matched: exclude,
          outcome: "excluded",
          coverageType: "EXCLUDE",
          matchedLevel: "district"
        };
      }
      const include = districtRows.find((r) => r.coverage_type === "INCLUDE");
      if (include) {
        return {
          matched: include,
          outcome: "covered",
          coverageType: "INCLUDE",
          matchedLevel: "district"
        };
      }
      const conditional = districtRows.find((r) => r.coverage_type === "CONDITIONAL");
      if (conditional) {
        return {
          matched: conditional,
          outcome: "conditional",
          coverageType: "CONDITIONAL",
          matchedLevel: "district"
        };
      }
      const branch = districtRows.find((r) => r.coverage_type === "BRANCH_DEPENDENT");
      if (branch) {
        return {
          matched: branch,
          outcome: "branch_dependent",
          coverageType: "BRANCH_DEPENDENT",
          matchedLevel: "district"
        };
      }
    }
  }
  return { matched: null, outcome: "not_covered", coverageType: null, matchedLevel: null };
}
function evaluateBankGeoCoverage({
  bankHasGeoPolicy,
  coverageRows,
  addressChecks,
  districtName = null
}) {
  if (!bankHasGeoPolicy) {
    return {
      geoStatus: "skipped",
      geoCovered: null,
      showInScoredList: true,
      customerMessageKey: null,
      reason: "No geo policy configured — geo skipped",
      pinResults: []
    };
  }
  const pinResults = [];
  for (const check of addressChecks.pins || []) {
    if (!check.pincode) {
      pinResults.push({
        role: check.role,
        pincode: null,
        outcome: "missing_pin",
        coverageType: null,
        matchedLevel: null
      });
      continue;
    }
    const match = matchBankGeoForPin(coverageRows, {
      pincode: check.pincode,
      districtName
    });
    pinResults.push({
      role: check.role,
      pincode: check.pincode,
      ...match
    });
  }
  const isPass = (r) => r.outcome === "covered";
  const isReview = (r) => r.outcome === "conditional" || r.outcome === "branch_dependent";
  const isFail = (r) => r.outcome === "excluded" || r.outcome === "not_covered" || r.outcome === "missing_pin";
  if (addressChecks.requireAll) {
    if (pinResults.some(isFail) || pinResults.some((r) => r.outcome === "missing_pin")) {
      return {
        geoStatus: "not_covered",
        geoCovered: false,
        showInScoredList: false,
        customerMessageKey: "inReview",
        reason: "Required address PIN(s) not covered",
        pinResults
      };
    }
    if (pinResults.some(isReview)) {
      return {
        geoStatus: "conditional",
        geoCovered: false,
        showInScoredList: false,
        customerMessageKey: "inReview",
        reason: "Location under conditional / branch-dependent coverage",
        pinResults
      };
    }
    if (pinResults.every(isPass)) {
      return {
        geoStatus: "covered",
        geoCovered: true,
        showInScoredList: true,
        customerMessageKey: "covered",
        reason: "All required address PINs covered",
        pinResults
      };
    }
  }
  const primary = pinResults[0];
  const fallback = pinResults[1];
  if (primary && isPass(primary)) {
    return {
      geoStatus: "covered",
      geoCovered: true,
      showInScoredList: true,
      customerMessageKey: "covered",
      reason: "Current residence PIN covered",
      pinResults
    };
  }
  if (primary && isReview(primary)) {
    return {
      geoStatus: "conditional",
      geoCovered: false,
      showInScoredList: false,
      customerMessageKey: "inReview",
      reason: "Current residence under conditional coverage",
      pinResults
    };
  }
  if (fallback && isPass(fallback)) {
    return {
      geoStatus: "in_review",
      geoCovered: false,
      showInScoredList: false,
      customerMessageKey: "inReview",
      reason: "Permanent address covered after residence fallback — in review",
      pinResults
    };
  }
  if (fallback && isReview(fallback)) {
    return {
      geoStatus: "conditional",
      geoCovered: false,
      showInScoredList: false,
      customerMessageKey: "inReview",
      reason: "Permanent address under conditional coverage",
      pinResults
    };
  }
  return {
    geoStatus: "not_covered",
    geoCovered: false,
    showInScoredList: false,
    customerMessageKey: "inReview",
    reason: "Location not covered by bank",
    pinResults
  };
}
function partitionBanksByGeo(bankResults) {
  const scored = [];
  const inReview = [];
  for (const bank of bankResults || []) {
    if (bank.showInScoredList === false) inReview.push(bank);
    else scored.push(bank);
  }
  return { scored, inReview };
}
function buildOverallGeoMessage({ scored, inReview }) {
  if (scored.length > 0 && scored.some((b) => b.geoStatus === "covered" || b.geoStatus === "skipped")) {
    if (inReview.length === 0 && scored.every((b) => b.geoStatus === "skipped" || b.geoStatus === "covered")) {
      const anyCovered = scored.some((b) => b.geoStatus === "covered");
      return anyCovered ? GEO_MESSAGES.covered : null;
    }
    if (scored.some((b) => b.geoStatus === "covered")) return GEO_MESSAGES.covered;
  }
  if (inReview.length > 0 && scored.filter((b) => b.geoStatus === "covered").length === 0) {
    return GEO_MESSAGES.inReview;
  }
  if (scored.some((b) => b.geoStatus === "covered")) return GEO_MESSAGES.covered;
  if (inReview.length > 0) return GEO_MESSAGES.inReview;
  return null;
}
export {
  COVERAGE_TYPES,
  GEO_MESSAGES,
  buildAddressPinChecks,
  buildOverallGeoMessage,
  evaluateBankGeoCoverage,
  isPurchaseOrConstructionPurpose,
  isSecuredLoanCategory,
  matchBankGeoForPin,
  partitionBanksByGeo
};
