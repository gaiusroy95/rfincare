/** Returns calculator for investment marketplace products. */

function round2(n) {
  return Math.round(n * 100) / 100;
}

function lumpSumGrowth(principal, annualRate, years) {
  const r = annualRate / 100;
  if (r === 0) return principal;
  return principal * ((1 + r) ** years);
}

function couponBondMaturity(principal, couponRate, years) {
  const annualCoupon = principal * (couponRate / 100);
  return principal + annualCoupon * years;
}

function treasuryBillMaturity(principal, annualRate, tenureMonths) {
  const years = tenureMonths / 12;
  return principal * (1 + (annualRate / 100) * years);
}

function incomeYieldReturns(principal, annualYield, years, appreciationRate = 5) {
  const annualIncome = principal * (annualYield / 100);
  const totalIncome = annualIncome * years;
  const appreciatedPrincipal = lumpSumGrowth(principal, appreciationRate, years);
  return {
    maturityValue: appreciatedPrincipal,
    totalIncome,
    monthlyIncome: annualIncome / 12,
  };
}

const GOLD_TYPES = new Set(['sovereign_gold_bonds', 'digital_gold', 'gold_etf', 'silver_etf']);
const BOND_TYPES = new Set(['bonds', 'corporate_bonds', 'rbi_floating_bonds', 'government_securities']);
const INCOME_TYPES = new Set(['reit', 'invit']);

/**
 * @param {object} input
 * @param {string} [input.calculatorType] - investment category slug
 * @param {number} [input.investmentAmount]
 * @param {number} [input.annualReturn] - expected return / yield % p.a.
 * @param {number} [input.couponRate]
 * @param {number} [input.tenureYears]
 * @param {number} [input.tenureMonths]
 */
export function calculateInvestmentReturns(input = {}) {
  const type = String(input.calculatorType || 'lump_sum').toLowerCase();
  const principal = Number(input.investmentAmount ?? input.principal ?? 100000);
  const annualReturn = Number(input.annualReturn ?? input.expectedReturn ?? 8);
  const couponRate = Number(input.couponRate ?? annualReturn);
  const tenureYears = input.tenureYears != null && input.tenureYears !== ''
    ? Number(input.tenureYears)
    : input.tenureMonths != null && input.tenureMonths !== ''
      ? Number(input.tenureMonths) / 12
      : 5;
  const tenureMonths = Number(input.tenureMonths ?? Math.round(tenureYears * 12));

  let maturityValue = 0;
  let totalInvested = principal;
  let returnsAmount = 0;
  let monthlyIncome = null;
  let summary = '';

  if (type === 'treasury_bills') {
    maturityValue = treasuryBillMaturity(principal, annualReturn, tenureMonths);
    summary = `T-Bill investment ₹${principal.toLocaleString('en-IN')} for ${tenureMonths} months at ${annualReturn}% p.a. (illustrative)`;
  } else if (BOND_TYPES.has(type)) {
    maturityValue = couponBondMaturity(principal, couponRate, tenureYears);
    summary = `Bond ₹${principal.toLocaleString('en-IN')} with ${couponRate}% coupon for ${tenureYears} years (simple interest, no reinvestment)`;
  } else if (INCOME_TYPES.has(type)) {
    const result = incomeYieldReturns(principal, annualReturn, tenureYears);
    maturityValue = result.maturityValue;
    monthlyIncome = result.monthlyIncome;
    summary = `Income asset ₹${principal.toLocaleString('en-IN')} at ${annualReturn}% yield for ${tenureYears} years with modest capital appreciation`;
  } else if (GOLD_TYPES.has(type)) {
    maturityValue = lumpSumGrowth(principal, annualReturn, tenureYears);
    summary = `Gold investment ₹${principal.toLocaleString('en-IN')} for ${tenureYears} years at ${annualReturn}% p.a. (illustrative appreciation)`;
  } else {
    maturityValue = lumpSumGrowth(principal, annualReturn, tenureYears);
    summary = `Investment ₹${principal.toLocaleString('en-IN')} for ${tenureYears} years at ${annualReturn}% p.a. compounded annually`;
  }

  returnsAmount = maturityValue - totalInvested;

  return {
    calculatorType: type,
    investmentAmount: round2(principal),
    annualReturn: round2(annualReturn),
    couponRate: BOND_TYPES.has(type) ? round2(couponRate) : null,
    tenureYears: round2(tenureYears),
    tenureMonths,
    totalInvested: round2(totalInvested),
    maturityValue: round2(maturityValue),
    returnsAmount: round2(returnsAmount),
    effectiveReturnsPercent: totalInvested > 0 ? round2((returnsAmount / totalInvested) * 100) : 0,
    monthlyIncome: monthlyIncome != null ? round2(monthlyIncome) : null,
    summary,
  };
}
