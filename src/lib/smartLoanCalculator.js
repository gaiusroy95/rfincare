import { calculateEmi, round2, toNum } from './financialCalculators/math.js';

export const SMART_LOAN_PRIORITIES = [
  'low_roi',
  'low_emi',
  'max_tenure',
  'low_foreclosure',
  'low_part_payment',
  'low_bounce',
  'low_late_fee',
];

const GST_ON_PROCESSING_DEFAULT = 18;

/** Outstanding principal after `paidMonths` of EMI payments (reducing balance). */
export function outstandingPrincipal(principal, annualRate, tenureMonths, paidMonths) {
  const p = toNum(principal);
  const n = Math.max(1, Math.round(toNum(tenureMonths, 12)));
  const m = Math.max(0, Math.min(n, Math.round(toNum(paidMonths, 0))));
  const r = toNum(annualRate) / 100 / 12;
  if (m >= n) return 0;
  if (r === 0) return round2(p * ((n - m) / n));
  const factorN = (1 + r) ** n;
  const factorM = (1 + r) ** m;
  return round2((p * (factorN - factorM)) / (factorN - 1));
}

function resolveRate(product) {
  const min = toNum(product.interestRateMin ?? product.interest_rate_min, NaN);
  const max = toNum(product.interestRateMax ?? product.interest_rate_max, NaN);
  const single = toNum(product.interestRate ?? product.interest_rate, NaN);
  if (Number.isFinite(single) && single > 0) return single;
  if (Number.isFinite(min) && Number.isFinite(max) && min > 0) return (min + max) / 2;
  if (Number.isFinite(min) && min > 0) return min;
  if (Number.isFinite(max) && max > 0) return max;
  return 12;
}

function resolveProcessingFee(product, principal) {
  const pct = toNum(
    product.processingFeePercentage ?? product.processing_fee_percentage,
    NaN,
  );
  const fixed = toNum(product.processingFeeFixed ?? product.processing_fee_fixed, NaN);
  let fee = 0;
  if (Number.isFinite(pct) && pct > 0) fee += (principal * pct) / 100;
  if (Number.isFinite(fixed) && fixed > 0) fee += fixed;
  return round2(fee);
}

function resolveNumericFee(product, keys, fallback = null) {
  for (const key of keys) {
    const n = toNum(product[key], NaN);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback;
}

/**
 * Score one product under SmartLoan assumptions.
 */
export function scoreSmartLoanProduct(product, input) {
  const principal = toNum(input.loanAmount);
  const tenureMonths = Math.max(1, Math.round(toNum(input.tenureMonths, 60)));
  const priorities = new Set(
    (input.priorities || []).map((p) => String(p).toLowerCase().replace(/-/g, '_')),
  );
  const gstPct = toNum(input.gstOnProcessingPct, GST_ON_PROCESSING_DEFAULT);
  const rate = resolveRate(product);
  const emiResult = calculateEmi(principal, rate, tenureMonths);
  const processingFee = resolveProcessingFee(product, principal);
  const gstOnFee = round2((processingFee * gstPct) / 100);
  const totalInterest = emiResult.totalInterest;
  const totalRepayment = round2(emiResult.totalPayment + processingFee + gstOnFee);

  const foreclosureFeePct = resolveNumericFee(
    product,
    ['foreclosureFeePct', 'foreclosure_fee_pct'],
    priorities.has('low_foreclosure') ? 4 : null,
  );
  const foreclosureAfterMonths = resolveNumericFee(
    product,
    ['foreclosureAllowedAfterMonths', 'foreclosure_allowed_after_months'],
    12,
  );
  const partPaymentFeePct = resolveNumericFee(
    product,
    ['partPaymentFeePct', 'part_payment_fee_pct'],
    priorities.has('low_part_payment') ? 2 : null,
  );
  const bounceFee = resolveNumericFee(
    product,
    ['bouncingCharges', 'bouncing_charges', 'bounceFee'],
    500,
  );
  const lateFeePct = resolveNumericFee(
    product,
    ['lateFeePct', 'late_fee_pct', 'latePaymentFeePct'],
    null,
  );
  const lateFeeFixed = resolveNumericFee(
    product,
    ['latePaymentFeeFixed', 'late_payment_fee_fixed'],
    0,
  );

  let simulatedCost = totalRepayment;
  const scenarios = {};
  const assumptions = [];

  if (priorities.has('low_foreclosure')) {
    const closeAt = Math.max(
      Math.round(tenureMonths / 2),
      Math.round(toNum(foreclosureAfterMonths, 12)),
    );
    const outstanding = outstandingPrincipal(principal, rate, tenureMonths, closeAt);
    const feePct = foreclosureFeePct == null ? 4 : foreclosureFeePct;
    if (foreclosureFeePct == null) assumptions.push('foreclosure_fee_pct_default_4');
    const foreclosureFee = round2((outstanding * feePct) / 100);
    const interestPaid = round2(
      emiResult.emi * closeAt - (principal - outstanding),
    );
    const foreclosureTotal = round2(
      emiResult.emi * closeAt + foreclosureFee + processingFee + gstOnFee,
    );
    scenarios.foreclosure = {
      closeAtMonths: closeAt,
      outstanding,
      foreclosureFee,
      interestPaid,
      totalOutflow: foreclosureTotal,
      feePct,
    };
    simulatedCost = foreclosureTotal;
  }

  if (priorities.has('low_part_payment') && tenureMonths > 12) {
    const afterMonths = 12;
    const lumpPct = 20;
    const outstandingBefore = outstandingPrincipal(principal, rate, tenureMonths, afterMonths);
    const lump = round2((principal * lumpPct) / 100);
    const feePct = partPaymentFeePct == null ? 2 : partPaymentFeePct;
    if (partPaymentFeePct == null) assumptions.push('part_payment_fee_pct_default_2');
    const partFee = round2((lump * feePct) / 100);
    const remainingPrincipal = Math.max(0, outstandingBefore - lump);
    const remainingTenure = tenureMonths - afterMonths;
    const afterEmi = calculateEmi(remainingPrincipal, rate, remainingTenure);
    const partPaymentTotal = round2(
      emiResult.emi * afterMonths + lump + partFee + afterEmi.totalPayment + processingFee + gstOnFee,
    );
    scenarios.partPayment = {
      afterMonths,
      lumpPercent: lumpPct,
      lumpAmount: lump,
      partPaymentFee: partFee,
      feePct,
      remainingPrincipal,
      revisedEmi: afterEmi.emi,
      totalOutflow: partPaymentTotal,
    };
    // Blend: if both foreclosure and part-payment priorities, average; else use part-payment
    if (priorities.has('low_foreclosure') && scenarios.foreclosure) {
      simulatedCost = round2((scenarios.foreclosure.totalOutflow + partPaymentTotal) / 2);
    } else {
      simulatedCost = partPaymentTotal;
    }
  }

  if (priorities.has('low_emi')) {
    simulatedCost = round2(simulatedCost + emiResult.emi * 0.01);
  }
  if (priorities.has('low_roi')) {
    simulatedCost = round2(simulatedCost + totalInterest * 0.001);
  }
  if (priorities.has('max_tenure')) {
    const maxTenureYears = toNum(
      product.maxTenureYears ?? product.max_tenure_years,
      tenureMonths / 12,
    );
    simulatedCost = round2(simulatedCost - maxTenureYears * 100);
  }

  // Tie-breaker penalties (small)
  if (priorities.has('low_bounce')) {
    simulatedCost = round2(simulatedCost + toNum(bounceFee, 500) * 0.1);
  }
  if (priorities.has('low_late_fee')) {
    const late = lateFeePct != null
      ? (emiResult.emi * lateFeePct) / 100
      : toNum(lateFeeFixed, 0);
    simulatedCost = round2(simulatedCost + late * 0.1);
  }

  return {
    productId: product.productId || product.id || product.compareKey,
    name: product.productName || product.name,
    bankName: product.name || product.bankName || product.provider,
    interestRate: round2(rate),
    emi: emiResult.emi,
    totalInterest,
    processingFee,
    gstOnFee,
    totalRepayment,
    simulatedScoreCost: simulatedCost,
    maxTenureYears: toNum(product.maxTenureYears ?? product.max_tenure_years, null),
    foreclosureFeePct,
    partPaymentFeePct,
    bouncingCharges: bounceFee,
    scenarios,
    assumptions,
  };
}

/**
 * Rank compared products and build savings insight.
 */
export function rankSmartLoanProducts(products, input) {
  const scored = (products || []).map((p) => scoreSmartLoanProduct(p, input));
  scored.sort((a, b) => a.simulatedScoreCost - b.simulatedScoreCost);

  const winner = scored[0] || null;
  const runnerUp = scored[1] || null;
  let savingsInsight = '';
  let savingsAmount = 0;

  if (winner && runnerUp) {
    savingsAmount = round2(runnerUp.simulatedScoreCost - winner.simulatedScoreCost);
    if (savingsAmount > 0) {
      savingsInsight = `${winner.name || 'This product'} can save you approximately ₹${savingsAmount.toLocaleString('en-IN')} versus ${runnerUp.name || 'the next option'} under your selected priorities.`;
    } else {
      savingsInsight = `${winner.name || 'This product'} is the best fit for your priorities based on simulated total cost.`;
    }
  } else if (winner) {
    savingsInsight = `${winner.name || 'This product'} is your best available match for the selected priorities.`;
  }

  const usedDefaults = scored.some((row) => (row.assumptions || []).length > 0);

  return {
    winnerId: winner?.productId || null,
    winner,
    ranking: scored,
    savingsAmount,
    savingsInsight,
    badgeLabel: savingsAmount > 0 ? 'Highest Savings' : 'Best Match for Your Needs',
    ctaLabel: savingsAmount > 0 ? 'Apply – Max Savings' : 'Apply – Best Fit',
    usedDefaultFees: usedDefaults,
    feeDisclaimer: usedDefaults
      ? 'Some products are missing numeric foreclosure/part-payment fees in admin data. Default industry estimates were used for those fields — ask admin to fill Bank Product numeric charges for exact results.'
      : null,
    input: {
      loanAmount: toNum(input.loanAmount),
      tenureMonths: Math.round(toNum(input.tenureMonths, 60)),
      loanPurpose: input.loanPurpose || null,
      plannedLoanType: input.plannedLoanType || null,
      priorities: input.priorities || [],
    },
  };
}
