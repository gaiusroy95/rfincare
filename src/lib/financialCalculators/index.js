import {
  annuityPayout,
  calculateEmi,
  capitalGain,
  cagr,
  compoundInterest,
  debtConsolidation,
  epfCorpus,
  fdMaturity,
  fireNumber,
  goalSip,
  gratuity,
  gstAmount,
  hraExemption,
  incomeTaxNewRegime,
  incomeTaxOldRegime,
  inflationAdjustedValue,
  loanEligibility,
  lumpsumFutureValue,
  netWorth,
  npsProjection,
  pensionPayout,
  ppfMaturity,
  rdMaturity,
  rentVsBuy,
  retirementCorpus,
  round2,
  sipFutureValue,
  swpCorpus,
  toNum,
} from './math.js';
import { getCalculatorBySlug } from './registry.js';

function emiResult(input) {
  const principal = toNum(input.principal ?? input.loanAmount);
  const annualRate = toNum(input.annualRate ?? input.interestRate);
  const tenureMonths = toNum(input.tenureMonths ?? (input.tenureYears ? input.tenureYears * 12 : 60));
  const result = calculateEmi(principal, annualRate, tenureMonths);
  return {
    ...result,
    principal: round2(principal),
    annualRate,
    summary: `EMI of ₹${result.emi.toLocaleString('en-IN')}/month for ₹${principal.toLocaleString('en-IN')} at ${annualRate}% for ${tenureMonths} months`,
  };
}

function sipResult(input) {
  const monthly = toNum(input.monthlyInvestment ?? input.monthlyAmount);
  const ret = toNum(input.expectedReturn ?? input.annualReturn, 12);
  const years = toNum(input.tenureYears ?? input.years, 10);
  const months = Math.round(years * 12);
  const fv = sipFutureValue(monthly, ret, months);
  const invested = monthly * months;
  return {
    monthlyInvestment: round2(monthly),
    expectedReturn: ret,
    tenureYears: years,
    totalInvested: round2(invested),
    futureValue: round2(fv),
    returnsAmount: round2(fv - invested),
    summary: `SIP ₹${monthly.toLocaleString('en-IN')}/month → ₹${round2(fv).toLocaleString('en-IN')} in ${years} years at ${ret}% p.a.`,
  };
}

function stepUpSipResult(input) {
  const base = toNum(input.monthlyInvestment, 5000);
  const stepUp = toNum(input.stepUpPercent, 10) / 100;
  const ret = toNum(input.expectedReturn, 12) / 100 / 12;
  const months = Math.round(toNum(input.tenureYears, 15) * 12);
  let balance = 0;
  let monthly = base;
  let invested = 0;
  for (let i = 0; i < months; i += 1) {
    balance = balance * (1 + ret) + monthly;
    invested += monthly;
    if (i > 0 && i % 12 === 0) monthly *= 1 + stepUp;
  }
  return {
    totalInvested: round2(invested),
    futureValue: round2(balance),
    returnsAmount: round2(balance - invested),
    summary: `Step-up SIP from ₹${base.toLocaleString('en-IN')}/month with ${stepUp * 100}% annual increase`,
  };
}

function swpResult(input) {
  const monthly = toNum(input.monthlyWithdrawal);
  const ret = toNum(input.expectedReturn, 8);
  const years = toNum(input.tenureYears, 25);
  const corpus = swpCorpus(monthly, ret, years);
  return {
    corpusRequired: round2(corpus),
    monthlyWithdrawal: round2(monthly),
    expectedReturn: ret,
    tenureYears: years,
    summary: `Corpus of ₹${round2(corpus).toLocaleString('en-IN')} needed for ₹${monthly.toLocaleString('en-IN')}/month SWP for ${years} years`,
  };
}

function lumpsumResult(input) {
  const amount = toNum(input.amount ?? input.principal ?? input.lumpsumAmount);
  const ret = toNum(input.expectedReturn ?? input.annualRate, 12);
  const years = toNum(input.tenureYears ?? input.years, 10);
  const fv = lumpsumFutureValue(amount, ret, years);
  return {
    amount: round2(amount),
    futureValue: round2(fv),
    returnsAmount: round2(fv - amount),
    expectedReturn: ret,
    tenureYears: years,
    summary: `₹${amount.toLocaleString('en-IN')} grows to ₹${round2(fv).toLocaleString('en-IN')} in ${years} years at ${ret}% p.a.`,
  };
}

function fdResult(input) {
  const principal = toNum(input.principal);
  const rate = toNum(input.annualRate, 7.5);
  const years = toNum(input.years ?? input.tenureYears, 5);
  const maturity = fdMaturity(principal, rate, years);
  return {
    principal: round2(principal),
    maturityValue: round2(maturity),
    returnsAmount: round2(maturity - principal),
    annualRate: rate,
    tenureYears: years,
    summary: `FD ₹${principal.toLocaleString('en-IN')} matures to ₹${round2(maturity).toLocaleString('en-IN')} in ${years} years at ${rate}%`,
  };
}

function rdResult(input) {
  const monthly = toNum(input.monthlyDeposit);
  const rate = toNum(input.annualRate, 7);
  const months = toNum(input.months ?? input.tenureMonths ?? 60);
  const maturity = rdMaturity(monthly, rate, months);
  const invested = monthly * months;
  return {
    monthlyDeposit: round2(monthly),
    maturityValue: round2(maturity),
    totalInvested: round2(invested),
    returnsAmount: round2(maturity - invested),
    summary: `RD ₹${monthly.toLocaleString('en-IN')}/month → ₹${round2(maturity).toLocaleString('en-IN')} in ${months} months`,
  };
}

function ppfResult(input) {
  const yearly = toNum(input.annualDeposit ?? input.principal);
  const rate = toNum(input.annualRate, 7.1);
  const years = toNum(input.years ?? input.tenureYears, 15);
  const maturity = ppfMaturity(yearly, rate, years);
  const invested = yearly * years;
  return {
    annualDeposit: round2(yearly),
    maturityValue: round2(maturity),
    totalInvested: round2(invested),
    returnsAmount: round2(maturity - invested),
    summary: `PPF ₹${yearly.toLocaleString('en-IN')}/year → ₹${round2(maturity).toLocaleString('en-IN')} in ${years} years`,
  };
}

function incomeTaxResult(input) {
  const income = toNum(input.annualIncome);
  const deductions = toNum(input.deductions);
  const regime = String(input.regime || 'both').toLowerCase();
  const oldTax = incomeTaxOldRegime(income, deductions);
  const newTax = incomeTaxNewRegime(income);
  const recommended = oldTax.totalTax <= newTax.totalTax ? 'old' : 'new';
  return {
    oldRegime: oldTax,
    newRegime: newTax,
    recommendedRegime: recommended,
    taxSavings: round2(Math.abs(oldTax.totalTax - newTax.totalTax)),
    summary:
      regime === 'both'
        ? `Recommended: ${recommended} regime (saves ₹${round2(Math.abs(oldTax.totalTax - newTax.totalTax)).toLocaleString('en-IN')})`
        : `Tax under ${regime} regime: ₹${(regime === 'old' ? oldTax : newTax).totalTax.toLocaleString('en-IN')}`,
  };
}

function loanPrepaymentResult(input) {
  const base = emiResult(input);
  const prepay = toNum(input.prepayment);
  const afterMonths = toNum(input.afterMonths, 24);
  const remainingPrincipal = Math.max(0, base.principal - prepay);
  const remainingMonths = base.tenureMonths - afterMonths;
  const newEmi = calculateEmi(remainingPrincipal, base.annualRate, remainingMonths);
  return {
    ...base,
    prepayment: round2(prepay),
    remainingPrincipal: round2(remainingPrincipal),
    newEmi: newEmi.emi,
    interestSaved: round2(base.totalInterest - newEmi.totalInterest),
    summary: `Prepay ₹${prepay.toLocaleString('en-IN')} → new EMI ₹${newEmi.emi.toLocaleString('en-IN')}`,
  };
}

function balanceTransferResult(input) {
  const outstanding = toNum(input.outstanding);
  const current = calculateEmi(outstanding, toNum(input.currentRate, 14), toNum(input.tenureMonths, 36));
  const transferred = calculateEmi(outstanding, toNum(input.newRate, 10.5), toNum(input.tenureMonths, 36));
  return {
    currentEmi: current.emi,
    newEmi: transferred.emi,
    monthlySavings: round2(current.emi - transferred.emi),
    totalInterestSaved: round2(current.totalInterest - transferred.totalInterest),
    summary: `Save ₹${round2(current.emi - transferred.emi).toLocaleString('en-IN')}/month with balance transfer`,
  };
}

function tdsResult(input) {
  const amount = toNum(input.amount);
  const rate = toNum(input.tdsRate, 10);
  const tds = amount * rate / 100;
  return { grossAmount: round2(amount), tdsAmount: round2(tds), netAmount: round2(amount - tds), tdsRate: rate };
}

function section80cResult(input) {
  const total = toNum(input.ppf) + toNum(input.elss) + toNum(input.epf) + toNum(input.lifeInsurance) + toNum(input.others);
  const limit = 150000;
  const claimed = Math.min(total, limit);
  return { totalInvestments: round2(total), deductionClaimed: round2(claimed), remainingLimit: round2(Math.max(0, limit - claimed)), limit };
}

function section80dResult(input) {
  const selfLimit = 25000;
  const parentLimit = input.parentsSenior ? 50000 : 25000;
  const self = Math.min(toNum(input.selfPremium), selfLimit);
  const parents = Math.min(toNum(input.parentsPremium), parentLimit);
  return { selfDeduction: round2(self), parentsDeduction: round2(parents), totalDeduction: round2(self + parents) };
}

function advanceTaxResult(input) {
  const tax = incomeTaxNewRegime(toNum(input.annualIncome));
  const paid = toNum(input.tdsPaid);
  const due = Math.max(0, tax.totalTax - paid);
  return { estimatedAnnualTax: tax.totalTax, tdsPaid: round2(paid), advanceTaxDue: round2(due), quarterlyInstallment: round2(due / 4) };
}

function stampDutyResult(input) {
  const value = toNum(input.propertyValue);
  const pct = toNum(input.stampDutyPercent, 5);
  const duty = value * pct / 100;
  return { propertyValue: round2(value), stampDuty: round2(duty), stampDutyPercent: pct };
}

function propertyRegistrationResult(input) {
  const value = toNum(input.propertyValue);
  const pct = toNum(input.registrationPercent, 1);
  const fee = value * pct / 100;
  return { propertyValue: round2(value), registrationFee: round2(fee), registrationPercent: pct };
}

function salaryBreakupResult(input) {
  const ctc = toNum(input.ctc);
  const basicPct = toNum(input.basicPercent, 40) / 100;
  const basic = ctc * basicPct / 12;
  const hra = basic * 0.5;
  const pf = basic * 0.12 * 2;
  const gross = ctc / 12;
  const inHand = gross - pf - gross * 0.1;
  return { monthlyCtc: round2(ctc / 12), basic: round2(basic), hra: round2(hra), pf: round2(pf), estimatedInHand: round2(inHand) };
}

function breakevenResult(input) {
  const fixed = toNum(input.fixedCost);
  const variable = toNum(input.variableCostPerUnit);
  const price = toNum(input.pricePerUnit);
  const units = fixed / Math.max(1, price - variable);
  return { breakevenUnits: round2(units), breakevenRevenue: round2(units * price) };
}

function bondYieldResult(input) {
  const face = toNum(input.faceValue, 1000);
  const coupon = toNum(input.couponRate, 7) / 100;
  const years = toNum(input.years, 5);
  const price = toNum(input.marketPrice, face);
  const annualCoupon = face * coupon;
  const ytm = ((annualCoupon + (face - price) / years) / ((face + price) / 2)) * 100;
  return { yieldToMaturity: round2(ytm), annualCoupon: round2(annualCoupon) };
}

function affordabilityResult(input) {
  const elig = loanEligibility(input.monthlyIncome, input.existingEmi, input.interestRate, input.tenureYears);
  const maxHome = elig.eligibleLoanAmount + toNum(input.downPayment);
  return { ...elig, maxAffordableHomePrice: round2(maxHome) };
}

const ENGINE_RUNNERS = {
  emi: emiResult,
  sip: sipResult,
  'step-up-sip': stepUpSipResult,
  swp: swpResult,
  lumpsum: lumpsumResult,
  fd: fdResult,
  rd: rdResult,
  ppf: ppfResult,
  'compound-interest': (input) => {
    const r = compoundInterest(input.principal, input.annualRate, input.years, input.compoundingFrequency);
    return { ...r, principal: toNum(input.principal), summary: `Maturity: ₹${r.amount.toLocaleString('en-IN')}` };
  },
  cagr: (input) => cagr(input.beginValue, input.endValue, input.years),
  'loan-eligibility': loanEligibility,
  'debt-consolidation': debtConsolidation,
  'loan-prepayment': loanPrepaymentResult,
  'balance-transfer': balanceTransferResult,
  'income-tax': incomeTaxResult,
  hra: hraExemption,
  'capital-gain': capitalGain,
  gst: (input) => gstAmount(input.amount, input.gstRate, input.inclusive),
  tds: tdsResult,
  'section-80c': section80cResult,
  'section-80d': section80dResult,
  'advance-tax': advanceTaxResult,
  'retirement-corpus': retirementCorpus,
  pension: pensionPayout,
  nps: npsProjection,
  annuity: annuityPayout,
  epf: epfCorpus,
  gratuity: gratuity,
  'goal-sip': goalSip,
  'net-worth': netWorth,
  fire: fireNumber,
  inflation: (input) => ({
    todayValue: inflationAdjustedValue(input.futureValue, input.inflationRate, input.years),
    futureValue: toNum(input.futureValue),
    inflationRate: toNum(input.inflationRate),
    years: toNum(input.years),
  }),
  'rent-vs-buy': rentVsBuy,
  'stamp-duty': stampDutyResult,
  'property-registration': propertyRegistrationResult,
  'salary-breakup': salaryBreakupResult,
  breakeven: breakevenResult,
  'bond-yield': bondYieldResult,
  affordability: affordabilityResult,
};

export function runCalculator(slug, input = {}) {
  const meta = getCalculatorBySlug(slug);
  if (!meta) {
    const err = new Error('Calculator not found');
    err.status = 404;
    throw err;
  }
  const runner = ENGINE_RUNNERS[meta.engine];
  if (!runner) {
    const err = new Error(`Calculator engine not implemented: ${meta.engine}`);
    err.status = 500;
    throw err;
  }
  const merged = { ...meta.defaults, ...input };
  const result = runner(merged);
  return {
    slug,
    title: meta.title,
    category: meta.category,
    engine: meta.engine,
    input: merged,
    result,
  };
}

export { CALCULATOR_CATEGORIES, CALCULATOR_REGISTRY, getCalculatorBySlug, listCalculators } from './registry.js';
