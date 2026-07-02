/** SIP / lumpsum returns calculator for mutual fund marketplace. */

function round2(n) {
  return Math.round(n * 100) / 100;
}

function sipFutureValue(monthlyInvestment, annualReturnPercent, months) {
  const monthlyRate = annualReturnPercent / 100 / 12;
  if (monthlyRate === 0) return monthlyInvestment * months;
  return monthlyInvestment * (((1 + monthlyRate) ** months - 1) / monthlyRate) * (1 + monthlyRate);
}

function lumpsumFutureValue(amount, annualReturnPercent, years) {
  const annualRate = annualReturnPercent / 100;
  if (annualRate === 0) return amount;
  return amount * ((1 + annualRate) ** years);
}

/**
 * @param {object} input
 * @param {'sip'|'lumpsum'} [input.investmentMode]
 * @param {number} [input.monthlyInvestment]
 * @param {number} [input.lumpsumAmount]
 * @param {number} [input.expectedReturn] - % p.a. before expenses
 * @param {number} [input.expenseRatio] - % p.a. deducted from returns
 * @param {number} [input.tenureYears]
 */
export function calculateMutualFundReturns(input = {}) {
  const mode = String(input.investmentMode || 'sip').toLowerCase() === 'lumpsum' ? 'lumpsum' : 'sip';
  const monthlyInvestment = Number(input.monthlyInvestment ?? 5000);
  const lumpsumAmount = Number(input.lumpsumAmount ?? input.principal ?? 100000);
  const expectedReturn = Number(input.expectedReturn ?? input.annualReturn ?? 12);
  const expenseRatio = Number(input.expenseRatio ?? 0);
  const tenureYears = Number(input.tenureYears ?? 10);
  const months = Math.max(1, Math.round(tenureYears * 12));

  const netAnnualReturn = Math.max(0, expectedReturn - expenseRatio);

  let totalInvested = 0;
  let futureValue = 0;
  let summary = '';

  if (mode === 'sip') {
    totalInvested = monthlyInvestment * months;
    futureValue = sipFutureValue(monthlyInvestment, netAnnualReturn, months);
    summary = `SIP of ₹${monthlyInvestment.toLocaleString('en-IN')}/month for ${tenureYears} years at ${netAnnualReturn}% p.a. (net of ${expenseRatio}% expense ratio)`;
  } else {
    totalInvested = lumpsumAmount;
    futureValue = lumpsumFutureValue(lumpsumAmount, netAnnualReturn, tenureYears);
    summary = `Lumpsum ₹${lumpsumAmount.toLocaleString('en-IN')} for ${tenureYears} years at ${netAnnualReturn}% p.a. (net of ${expenseRatio}% expense ratio)`;
  }

  const returnsAmount = futureValue - totalInvested;

  return {
    investmentMode: mode,
    monthlyInvestment: mode === 'sip' ? round2(monthlyInvestment) : null,
    lumpsumAmount: mode === 'lumpsum' ? round2(lumpsumAmount) : null,
    expectedReturn: round2(expectedReturn),
    expenseRatio: round2(expenseRatio),
    netAnnualReturn: round2(netAnnualReturn),
    tenureYears: round2(tenureYears),
    tenureMonths: months,
    totalInvested: round2(totalInvested),
    futureValue: round2(futureValue),
    returnsAmount: round2(returnsAmount),
    effectiveReturnsPercent: totalInvested > 0 ? round2((returnsAmount / totalInvested) * 100) : 0,
    summary,
  };
}
