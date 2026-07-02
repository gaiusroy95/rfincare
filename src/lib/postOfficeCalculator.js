/** Maturity / returns calculator for post office investment products. */

function round2(n) {
  return Math.round(n * 100) / 100;
}

function formatInr(n) {
  if (!Number.isFinite(n)) return null;
  return round2(n);
}

function compoundFv(principal, annualRate, years, compoundsPerYear = 1) {
  const r = annualRate / 100;
  const n = compoundsPerYear;
  const t = years;
  return principal * ((1 + r / n) ** (n * t));
}

function recurringDepositMaturity(monthlyDeposit, annualRate, months) {
  const r = annualRate / 100 / 12;
  if (r === 0) return monthlyDeposit * months;
  return monthlyDeposit * (((1 + r) ** months - 1) / r) * (1 + r);
}

function annualContributionFv(annualDeposit, annualRate, years) {
  const r = annualRate / 100;
  if (r === 0) return annualDeposit * years;
  return annualDeposit * (((1 + r) ** years - 1) / r) * (1 + r);
}

function monthlyIncomeFromPrincipal(principal, annualRate) {
  return (principal * (annualRate / 100)) / 12;
}

/**
 * @param {object} input
 * @param {string} input.calculatorType - ppf, nsc, kvp, sukanya_samriddhi, senior_citizen_savings, monthly_income_scheme, time_deposit, recurring_deposit
 * @param {number} input.principal - lump sum or annual (PPF/SSY) or monthly (RD/MIS context)
 * @param {number} [input.monthlyDeposit] - for RD
 * @param {number} [input.annualDeposit] - for PPF/SSY yearly contribution
 * @param {number} input.annualRate - interest rate % p.a.
 * @param {number} input.tenureYears
 * @param {number} [input.tenureMonths]
 */
export function calculatePostOfficeMaturity(input = {}) {
  const type = String(input.calculatorType || 'time_deposit').toLowerCase();
  const annualRate = Number(input.annualRate ?? 7.1);
  const tenureYears = input.tenureYears != null && input.tenureYears !== ''
    ? Number(input.tenureYears)
    : input.tenureMonths != null && input.tenureMonths !== ''
      ? Number(input.tenureMonths) / 12
      : 5;
  const tenureMonths = Number(input.tenureMonths ?? Math.round(tenureYears * 12));
  const principal = Number(input.principal ?? input.lumpSum ?? 100000);
  const monthlyDeposit = Number(input.monthlyDeposit ?? input.monthlyContribution ?? 0);
  const annualDeposit = Number(input.annualDeposit ?? input.yearlyContribution ?? 0);

  let maturityValue = 0;
  let totalInvested = 0;
  let returnsAmount = 0;
  let monthlyIncome = null;
  let summary = '';

  switch (type) {
    case 'ppf':
    case 'sukanya_samriddhi': {
      const yearly = annualDeposit || principal;
      totalInvested = yearly * tenureYears;
      maturityValue = annualContributionFv(yearly, annualRate, tenureYears);
      summary = `Annual contribution ₹${yearly.toLocaleString('en-IN')} for ${tenureYears} years at ${annualRate}% p.a. (compounded annually)`;
      break;
    }
    case 'recurring_deposit': {
      const monthly = monthlyDeposit || principal;
      totalInvested = monthly * tenureMonths;
      maturityValue = recurringDepositMaturity(monthly, annualRate, tenureMonths);
      summary = `Monthly deposit ₹${monthly.toLocaleString('en-IN')} for ${tenureMonths} months at ${annualRate}% p.a.`;
      break;
    }
    case 'monthly_income_scheme': {
      totalInvested = principal;
      monthlyIncome = monthlyIncomeFromPrincipal(principal, annualRate);
      maturityValue = principal;
      summary = `Principal ₹${principal.toLocaleString('en-IN')} — estimated monthly payout at ${annualRate}% p.a.`;
      break;
    }
    case 'kvp': {
      totalInvested = principal;
      const doubleYears = annualRate > 0 ? Math.log(2) / Math.log(1 + annualRate / 100) : 10;
      maturityValue = principal * 2;
      summary = `KVP doubles investment in ~${round2(doubleYears)} years at ${annualRate}% p.a. (illustrative)`;
      break;
    }
    case 'nsc':
    case 'senior_citizen_savings':
    case 'time_deposit':
    default: {
      totalInvested = principal;
      const freq = type === 'senior_citizen_savings' ? 4 : 1;
      maturityValue = compoundFv(principal, annualRate, tenureYears, freq);
      summary = `Lump sum ₹${principal.toLocaleString('en-IN')} for ${tenureYears} years at ${annualRate}% p.a.`;
      break;
    }
  }

  returnsAmount = maturityValue - totalInvested;

  return {
    calculatorType: type,
    annualRate,
    tenureYears: round2(tenureYears),
    tenureMonths,
    principal,
    monthlyDeposit: monthlyDeposit || null,
    annualDeposit: annualDeposit || null,
    totalInvested: formatInr(totalInvested),
    maturityValue: formatInr(maturityValue),
    returnsAmount: formatInr(returnsAmount),
    effectiveReturnsPercent: totalInvested > 0 ? round2((returnsAmount / totalInvested) * 100) : 0,
    monthlyIncome: monthlyIncome != null ? formatInr(monthlyIncome) : null,
    summary,
  };
}
