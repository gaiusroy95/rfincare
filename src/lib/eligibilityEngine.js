import { getPool } from '../db/pool.js';
import { ensureMilestone3Schema } from '../db/ensureMilestone3Schema.js';
import { getMatchingConfig, DEFAULT_MATCHING_WEIGHTS, DEFAULT_DECISION_THRESHOLDS } from './matchingConfig.js';
import { evaluateRule, summarizeDecision } from './ruleEngine.js';
import { listEngineEligibilityRules, ensurePolicyConsoleSchema } from './policyConsole.js';
import { getApplicantAge } from './applicantAge.js';
import { ensureGeoSchema } from './geoHierarchy.js';
import {
  applyLocationServiceabilityGate,
  normalizeApplicationPincode,
  pickServiceabilityRow,
} from './lenderPinServiceability.js';
import {
  buildAddressPinChecks,
  buildOverallGeoMessage,
  evaluateBankGeoCoverage,
  partitionBanksByGeo,
  GEO_MESSAGES,
} from './lenderGeoEligibility.js';
import { loadActiveGeoCoverageByBank, ensureLenderGeoPolicySchema } from './lenderGeoPolicy.js';

const CREDIT_SCORE_MAP = {
  excellent: 780,
  good: 725,
  fair: 675,
  poor: 600,
  very_poor: 550,
  unknown: 650,
  '-1': 0,
  minus_1: 0,
  '0': 0,
  zero: 0,
  no_history: 0,
};

function normalizeCreditScoreKey(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === '-1' || raw === 'minus_1' || raw === 'minus 1') return '-1';
  if (raw === '0' || raw === 'zero') return '0';
  if (raw === 'no_history' || raw === 'no history' || raw === 'nohistory') return 'no_history';
  return String(value || '').trim();
}

function parseRuleData(row) {
  if (!row?.data) return {};
  if (typeof row.data === 'object') return row.data;
  try {
    return JSON.parse(row.data);
  } catch {
    return {};
  }
}

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function inferSecuredCategory(loanType) {
  const key = normalizeKey(loanType);
  if (!key) return 'unsecured';
  if (
    key.includes('home') ||
    key.includes('mortgage') ||
    key.includes('property') ||
    key.includes('auto') ||
    key.includes('car') ||
    key.includes('gold') ||
    key.includes('lap') ||
    key.includes('secured')
  ) {
    return 'secured';
  }
  return 'unsecured';
}

function normalizeEmploymentType(value) {
  return String(value || 'salaried').toLowerCase();
}

function pmt(annualRatePercent, months, principal) {
  const monthlyRate = Number(annualRatePercent || 0) / 1200;
  if (!months || months <= 0 || !principal || principal <= 0) return 0;
  if (monthlyRate <= 0) return principal / months;
  const factor = Math.pow(1 + monthlyRate, months);
  return (principal * monthlyRate * factor) / (factor - 1);
}

function principalFromEmi(annualRatePercent, months, emi) {
  const monthlyRate = Number(annualRatePercent || 0) / 1200;
  if (!months || months <= 0 || !emi || emi <= 0) return 0;
  if (monthlyRate <= 0) return emi * months;
  const factor = Math.pow(1 + monthlyRate, months);
  return (emi * (factor - 1)) / (monthlyRate * factor);
}

function getRuleNumber(ruleData, keys, fallback) {
  for (const key of keys) {
    const value = ruleData?.[key];
    if (value !== undefined && value !== null && value !== '') {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
  }
  return fallback;
}

const MAX_INPUT_AMOUNT = 1e12;

function clampAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_INPUT_AMOUNT);
}

function safeRound(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function employmentTypesMatch(ruleEmploymentTypes, employmentType) {
  if (!ruleEmploymentTypes) return true;
  if (Array.isArray(ruleEmploymentTypes)) {
    return ruleEmploymentTypes.map((t) => String(t).toLowerCase()).includes(employmentType);
  }
  const raw = String(ruleEmploymentTypes);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((t) => String(t).toLowerCase()).includes(employmentType);
    }
  } catch {
    /* use string match below */
  }
  return raw.toLowerCase().includes(employmentType);
}

export async function calculateEligibility(input) {
  await ensureMilestone3Schema();
  await ensurePolicyConsoleSchema().catch(() => {});
  const pool = getPool();
  const matchingConfig = await getMatchingConfig().catch(() => ({
    weights: DEFAULT_MATCHING_WEIGHTS,
    decisionThresholds: DEFAULT_DECISION_THRESHOLDS,
  }));
  const W = { ...DEFAULT_MATCHING_WEIGHTS, ...(matchingConfig.weights || {}) };
  const thresholds = {
    ...DEFAULT_DECISION_THRESHOLDS,
    ...(matchingConfig.decisionThresholds || {}),
  };

  const monthlyIncomeBase = clampAmount(input.monthlyIncome);
  const extraIncome = clampAmount(input.extraIncome ?? input.extra_income);
  const monthlyIncome = monthlyIncomeBase + extraIncome;
  const loanAmount = clampAmount(input.loanAmount);
  const existingLoans = clampAmount(input.existingLoans);
  const creditKey = normalizeCreditScoreKey(input.creditScore || input.creditScoreRange);
  const liveNumeric = Number(input.liveCreditScore);
  const creditScore = Number.isFinite(liveNumeric) && liveNumeric >= 300 && liveNumeric <= 900
    ? Math.round(liveNumeric)
    : CREDIT_SCORE_MAP[creditKey] ??
      CREDIT_SCORE_MAP[input.creditScore] ??
      CREDIT_SCORE_MAP[input.creditScoreRange] ??
      700;
  const employmentType = normalizeEmploymentType(input.employmentType);
  const loanType = input.loanType || input.loanPurpose || null;
  const loanCategory = inferSecuredCategory(loanType);
  const collateralValue = clampAmount(input.collateralValue ?? input.propertyValue);
  const yearsEmployed = Number(input.yearsEmployed ?? input.years_employed);
  const applicantAge = (() => {
    const fromInput = Number(input.age);
    if (Number.isFinite(fromInput) && fromInput > 0) return fromInput;
    return getApplicantAge(input.dateOfBirth || input.date_of_birth || input.dob);
  })();
  const applicantPincode = normalizeApplicationPincode(
    input.pincode || input.pinCode || input.pin_code || input.postal || input.currentPincode,
  );
  const addressChecks = buildAddressPinChecks(input, { loanCategory });
  const districtNameHint =
    input.district || input.districtName || input.propertyDistrict || input.city || null;

  let geoPolicy = { versionId: null, byBank: new Map(), bankIdsWithPolicy: new Set() };
  try {
    await ensureLenderGeoPolicySchema();
    geoPolicy = await loadActiveGeoCoverageByBank(pool);
  } catch {
    geoPolicy = { versionId: null, byBank: new Map(), bankIdsWithPolicy: new Set() };
  }

  const versionedRules = await listEngineEligibilityRules({}).catch(() => []);
  const rulesByBankVersioned = new Map();
  for (const vr of versionedRules) {
    const key = vr.bank_id || '__global__';
    if (!rulesByBankVersioned.has(key)) rulesByBankVersioned.set(key, []);
    rulesByBankVersioned.get(key).push(vr);
  }

  let propertyLtvByBank = new Map();
  try {
    const [ltvRows] = await pool.query(
      `SELECT plr.bank_id, plr.property_type, plr.max_ltv
       FROM property_ltv_rules plr
       LEFT JOIN product_policy_versions ppv ON ppv.id = plr.version_id
       WHERE plr.is_active = TRUE
         AND (
           (plr.version_id IS NOT NULL AND ppv.status = 'active')
           OR (
             plr.version_id IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM product_policy_versions v
               WHERE v.status = 'active' AND v.bank_id = plr.bank_id
             )
           )
         )`,
    );
    for (const row of ltvRows) {
      if (!propertyLtvByBank.has(row.bank_id)) propertyLtvByBank.set(row.bank_id, []);
      propertyLtvByBank.get(row.bank_id).push(row);
    }
  } catch {
    propertyLtvByBank = new Map();
  }

  const [banks] = await pool.query(
    `SELECT b.id, b.name, bp.id AS product_id, bp.name AS product_name, bp.data AS product_data
     FROM banks b
     LEFT JOIN bank_products bp ON bp.bank_id = b.id AND bp.is_active = TRUE
     WHERE b.status = 'active'
     ORDER BY b.display_priority DESC`,
  );

  const [rules] = await pool.query(
    `SELECT bank_id, approval_probability, priority, data
     FROM approval_matrix_rules
     WHERE is_active = TRUE
     ORDER BY priority DESC`,
  );

  const [matrixRates] = await pool.query(
    `SELECT bank_id, product_type, loan_type, interest_rate, credit_score_min, credit_score_max,
            loan_amount_min, loan_amount_max, term_max
     FROM interest_matrix_rates
     WHERE status = 'active'`,
  );

  const rulesByBank = new Map();
  for (const r of rules) {
    if (!rulesByBank.has(r.bank_id)) rulesByBank.set(r.bank_id, []);
    rulesByBank.get(r.bank_id).push(r);
  }

  /** bankId → { hasList, pinRows[] } for applicant PIN */
  const serviceabilityByBank = new Map();
  try {
    await ensureGeoSchema();
    const [coverageCounts] = await pool.query(
      `SELECT bank_id, COUNT(*)::int AS c
       FROM lender_serviceability
       WHERE level = 'pincode' AND pincode IS NOT NULL AND pincode <> ''
       GROUP BY bank_id`,
    );
    for (const row of coverageCounts) {
      serviceabilityByBank.set(row.bank_id, { hasList: Number(row.c) > 0, pinRows: [] });
    }
    if (applicantPincode) {
      const [pinRows] = await pool.query(
        `SELECT bank_id, bank_product_id, pincode, status, notes
         FROM lender_serviceability
         WHERE level = 'pincode' AND pincode = :pincode`,
        { pincode: applicantPincode },
      );
      for (const row of pinRows) {
        if (!serviceabilityByBank.has(row.bank_id)) {
          serviceabilityByBank.set(row.bank_id, { hasList: true, pinRows: [] });
        }
        serviceabilityByBank.get(row.bank_id).pinRows.push(row);
      }
    }
  } catch {
    serviceabilityByBank.clear();
  }

  const bankResults = [];
  const bankMap = new Map();
  const ratesByBank = new Map();

  for (const rate of matrixRates) {
    const bankId = rate.bank_id || '__generic__';
    if (!ratesByBank.has(bankId)) ratesByBank.set(bankId, []);
    ratesByBank.get(bankId).push(rate);
  }

  for (const row of banks) {
    if (!bankMap.has(row.id)) {
      bankMap.set(row.id, { bankId: row.id, bankName: row.name, products: [], bestProbability: 0 });
    }
    const entry = bankMap.get(row.id);
    if (row.product_id) {
      entry.products.push({ id: row.product_id, name: row.product_name });
    }
  }

  for (const [bankId, bank] of bankMap) {
    const bankRules = rulesByBank.get(bankId) || [];
    let probability = 50;
    let matchedRate = null;
    let eligibleAmount = 0;
    let maxMonthlyEmi = 0;

    const bankRates = [...(ratesByBank.get(bankId) || []), ...(ratesByBank.get('__generic__') || [])];
    const loanTypeKey = normalizeKey(loanType);
    const categoryKey = normalizeKey(loanCategory);
    const productMatch = bankRates.find((rate) => {
      const productKey = normalizeKey(rate.product_type);
      const rateLoanKey = normalizeKey(rate.loan_type);
      const creditOk = creditScore >= Number(rate.credit_score_min || 0) && creditScore <= Number(rate.credit_score_max || 900);
      const amountOk = loanAmount <= 0
        || (loanAmount >= Number(rate.loan_amount_min || 0) && loanAmount <= Number(rate.loan_amount_max || Number.MAX_SAFE_INTEGER));
      const loanMatch = !loanTypeKey || productKey.includes(loanTypeKey) || loanTypeKey.includes(productKey);
      const categoryMatch = !rateLoanKey || rateLoanKey.includes(categoryKey);
      return creditOk && amountOk && loanMatch && categoryMatch;
    });
    matchedRate = Number(productMatch?.interest_rate || (loanCategory === 'secured' ? 9.5 : 15.5));

    if (bankRules.length > 0) {
      const scores = bankRules.map((rule) => {
        const d = parseRuleData(rule);
        let score = rule.approval_probability ?? 50;
        const minIncome = Number(d.min_annual_income ?? d.minAnnualIncome ?? d.min_income ?? d.minIncome ?? 0);
        const maxIncome = Number(d.max_annual_income ?? d.maxAnnualIncome ?? d.max_income ?? d.maxIncome ?? Infinity);
        const minCredit = Number(d.min_credit_score ?? d.minCreditScore ?? 0);
        const maxCredit = Number(d.max_credit_score ?? d.maxCreditScore ?? 900);
        const minLoan = Number(d.min_loan_amount ?? d.minLoanAmount ?? 0);
        const maxLoan = Number(d.max_loan_amount ?? d.maxLoanAmount ?? Infinity);
        const annualIncome = monthlyIncome * 12;

        if (annualIncome < minIncome || (Number.isFinite(maxIncome) && annualIncome > maxIncome)) {
          score -= W.income_mismatch;
        }
        if (creditScore < minCredit || creditScore > maxCredit) score -= W.credit_mismatch;
        if (loanAmount < minLoan || loanAmount > maxLoan) score -= W.loan_amount_mismatch;
        if (!employmentTypesMatch(d.employment_types, employmentType)) score -= W.employment_mismatch;
        if (d.loan_types && loanType && !String(d.loan_types).includes(loanType)) {
          score -= W.loan_type_mismatch;
        }

        const minAge = getRuleNumber(d, ['min_age', 'minAge', 'age_min'], 21);
        const maxAge = getRuleNumber(d, ['max_age', 'maxAge', 'age_max'], 70);
        if (applicantAge != null) {
          if (applicantAge < minAge || applicantAge > maxAge) score -= W.age_mismatch;
        }

        const minYearsEmployed = getRuleNumber(
          d,
          ['min_years_employed', 'minYearsEmployed', 'min_employment_years', 'stability_years'],
          employmentType === 'salaried' ? 1 : 0,
        );
        if (Number.isFinite(yearsEmployed) && yearsEmployed >= 0 && yearsEmployed < minYearsEmployed) {
          score -= W.stability_mismatch;
        }

        const foirDefault = loanCategory === 'secured' ? 0.65 : employmentType === 'salaried' ? 0.55 : 0.5;
        const tenureDefault = loanCategory === 'secured' ? 240 : 60;
        const ltvDefault = loanCategory === 'secured' ? 0.75 : 1;

        const foir = getRuleNumber(
          d,
          ['foir', `${loanCategory}_foir`, `foir_${loanCategory}`, 'max_foir'],
          foirDefault,
        );
        const tenureMonths = getRuleNumber(
          d,
          [
            'tenure_months',
            `${loanCategory}_tenure_months`,
            `tenure_${loanCategory}_months`,
            'max_tenure_months',
          ],
          tenureDefault,
        );
        let ltv = getRuleNumber(
          d,
          ['ltv', 'ltv_ratio', 'max_ltv', `${loanCategory}_ltv`, `ltv_${loanCategory}`],
          ltvDefault,
        );
        const bankLtv = (propertyLtvByBank.get(bankId) || [])[0];
        if (bankLtv?.max_ltv != null && Number.isFinite(Number(bankLtv.max_ltv))) {
          ltv = Number(bankLtv.max_ltv);
        }
        maxMonthlyEmi = Math.max(0, monthlyIncome * foir - existingLoans);
        const emiEligible = principalFromEmi(matchedRate, tenureMonths, maxMonthlyEmi);
        const assetCap = loanCategory === 'secured' && collateralValue > 0 ? collateralValue * ltv : Number.MAX_SAFE_INTEGER;
        eligibleAmount = Math.max(eligibleAmount, Math.max(0, Math.min(emiEligible, assetCap)));

        const expectedEmi = pmt(matchedRate, tenureMonths, loanAmount);
        if (expectedEmi > maxMonthlyEmi) score -= W.emi_capacity_mismatch;
        if (loanCategory === 'secured' && collateralValue > 0 && loanAmount > collateralValue * ltv) {
          score -= W.ltv_mismatch;
        }
        return Math.max(0, Math.min(100, score));
      });
      probability = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    } else {
      const foir = loanCategory === 'secured' ? 0.65 : employmentType === 'salaried' ? 0.55 : 0.5;
      const tenureMonths = loanCategory === 'secured' ? 240 : 60;
      const ltv = loanCategory === 'secured' ? 0.75 : 1;
      maxMonthlyEmi = Math.max(0, monthlyIncome * foir - existingLoans);
      const emiEligible = principalFromEmi(matchedRate, tenureMonths, maxMonthlyEmi);
      const assetCap = loanCategory === 'secured' && collateralValue > 0 ? collateralValue * ltv : Number.MAX_SAFE_INTEGER;
      eligibleAmount = Math.max(0, Math.min(emiEligible, assetCap));
      const incomeRatio = loanAmount > 0 ? eligibleAmount / loanAmount : 1;
      probability = Math.min(95, Math.round(40 + incomeRatio * 30 + (creditScore - 600) / 10));
    }

    const applicantCtx = {
      monthlyIncome,
      loanAmount,
      creditScore,
      employmentType,
      age: applicantAge,
      yearsEmployed,
      existingLoans,
      collateralValue,
      loanType,
    };
    const versioned = [
      ...(rulesByBankVersioned.get(bankId) || []),
      ...(rulesByBankVersioned.get('__global__') || []),
    ];
    const ruleTraces = versioned.map((rule) =>
      evaluateRule(rule, rule.conditions || [], applicantCtx),
    );
    const criticalFail = ruleTraces.some(
      (t) => t.status === 'FAIL' && String(t.severity).toLowerCase() === 'critical',
    );
    if (criticalFail) {
      probability = Math.max(0, probability - (W.critical_fail_penalty || 100));
    } else {
      const softFails = ruleTraces.filter((t) => t.status === 'FAIL' && t.severity !== 'critical').length;
      if (softFails > 0) probability = Math.max(0, probability - softFails * 5);
    }

    const decisionInfo = summarizeDecision(ruleTraces, {
      eligibleMin: thresholds.eligible_min_probability,
      conditionalMin: thresholds.conditional_min_probability,
      probability,
    });

    // FOIR/LTV/credit first — then separate geo step (bank-level policy).
    bank.bestProbability = probability;
    bank.loanCategory = loanCategory;
    bank.eligibleAmount = safeRound(eligibleAmount);
    bank.maxMonthlyEmi = safeRound(maxMonthlyEmi);
    bank.estimatedRate = Number(matchedRate.toFixed(2));
    bank.decision = decisionInfo.decision;
    bank.decisionReason = decisionInfo.reason;
    bank.ruleTraceCount = ruleTraces.length;
    bank.applicantPincode = applicantPincode;

    const hasNewGeo = geoPolicy.bankIdsWithPolicy.has(bankId);
    if (geoPolicy.versionId && (hasNewGeo || geoPolicy.bankIdsWithPolicy.size > 0)) {
      const geoEval = evaluateBankGeoCoverage({
        bankHasGeoPolicy: hasNewGeo,
        coverageRows: geoPolicy.byBank.get(bankId) || [],
        addressChecks,
        districtName: districtNameHint,
      });
      bank.geoStatus = geoEval.geoStatus;
      bank.geoCovered = geoEval.geoCovered;
      bank.geoReason = geoEval.reason;
      bank.geoPinResults = geoEval.pinResults;
      bank.locationRemark = geoEval.reason;
      bank.locationCovered = geoEval.geoCovered;
      bank.locationStatus = geoEval.geoStatus;
      bank.showInScoredList = geoEval.showInScoredList;
      if (geoEval.showInScoredList === false) {
        bank.decision = geoEval.geoStatus === 'conditional' || geoEval.geoStatus === 'in_review'
          ? 'CONDITIONAL'
          : 'NOT_ELIGIBLE';
        bank.decisionReason = geoEval.reason;
      }
    } else {
      // Legacy PIN serviceability fallback when no active geo policy version
      const primaryProductId = bank.products?.[0]?.id || null;
      const svc = serviceabilityByBank.get(bankId) || { hasList: false, pinRows: [] };
      const svcRow = pickServiceabilityRow(svc.pinRows, {
        bankId,
        bankProductId: primaryProductId,
      });
      const locationGate = applyLocationServiceabilityGate({
        pincode: applicantPincode,
        bankHasCoverageList: Boolean(svc.hasList),
        row: svcRow,
        decision: decisionInfo.decision,
        decisionReason: decisionInfo.reason,
        probability,
        eligibleAmount,
      });
      bank.bestProbability = locationGate.probability;
      bank.eligibleAmount = safeRound(locationGate.eligibleAmount);
      bank.decision = locationGate.decision;
      bank.decisionReason = locationGate.decisionReason;
      bank.locationRemark = locationGate.locationRemark;
      bank.locationCovered = locationGate.locationCovered;
      bank.locationStatus = locationGate.locationStatus;
      bank.geoStatus =
        locationGate.locationCovered === true
          ? 'covered'
          : locationGate.locationCovered === false
            ? 'not_covered'
            : 'skipped';
      bank.showInScoredList = locationGate.locationCovered !== false;
    }

    bankResults.push(bank);
  }

  bankResults.sort((a, b) => b.bestProbability - a.bestProbability);
  const { scored, inReview } = partitionBanksByGeo(bankResults);
  const scoredForResponse = scored.slice(0, 12);
  const overallProbability = scoredForResponse.length
    ? Math.round(scoredForResponse.reduce((s, b) => s + b.bestProbability, 0) / scoredForResponse.length)
    : 0;

  const bestEligibleAmount = scoredForResponse.reduce((max, bank) => Math.max(max, bank.eligibleAmount || 0), 0);
  const maxMonthlyEmiOverall = scoredForResponse.reduce((max, bank) => Math.max(max, bank.maxMonthlyEmi || 0), 0);
  const eligibleMin = thresholds.eligible_min_probability;
  const conditionalMin = thresholds.conditional_min_probability;
  const approved = overallProbability >= eligibleMin && loanAmount <= bestEligibleAmount;
  const overallDecision = summarizeDecision([], {
    eligibleMin,
    conditionalMin,
    probability: overallProbability,
  }).decision;

  const geoMessage = buildOverallGeoMessage({ scored: scoredForResponse, inReview });
  const defaultMessage = approved
    ? 'Strong match with lender criteria based on current parameters.'
    : loanCategory === 'secured'
      ? 'For secured products, eligible amount is capped by FOIR and LTV. Higher collateral value can improve eligibility.'
      : 'For unsecured products, eligibility is calculated from FOIR-based EMI capacity and tenure. Lower existing EMI can improve approval odds.';

  return {
    overallProbability,
    eligibleAmount: safeRound(bestEligibleAmount),
    maxMonthlyEmi: safeRound(maxMonthlyEmiOverall),
    loanCategory,
    decision: overallDecision,
    status: approved ? 'likely_approved' : overallProbability >= conditionalMin ? 'conditional' : 'unlikely',
    message: geoMessage || defaultMessage,
    geoMessage: geoMessage || null,
    geoMessages: GEO_MESSAGES,
    banks: scoredForResponse,
    banksInReview: inReview.slice(0, 12),
    geoPolicyVersionId: geoPolicy.versionId,
    matchingWeights: W,
    decisionThresholds: thresholds,
    input: {
      monthlyIncome,
      loanAmount,
      creditScore,
      employmentType,
      loanType,
      collateralValue,
      pincode: applicantPincode,
      addressMode: addressChecks.mode,
    },
  };
}
