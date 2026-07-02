/** Shared financial math helpers for calculator engines. */

export function round2(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

export function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function calculateEmi(principal, annualRate, tenureMonths) {
  const p = toNum(principal);
  const n = Math.max(1, Math.round(toNum(tenureMonths, 12)));
  const r = toNum(annualRate) / 100 / 12;
  if (r === 0) {
    const emi = p / n;
    return { emi: round2(emi), totalPayment: round2(emi * n), totalInterest: 0, tenureMonths: n };
  }
  const factor = (1 + r) ** n;
  const emi = (p * r * factor) / (factor - 1);
  const totalPayment = emi * n;
  return {
    emi: round2(emi),
    totalPayment: round2(totalPayment),
    totalInterest: round2(totalPayment - p),
    tenureMonths: n,
  };
}

export function sipFutureValue(monthlyInvestment, annualReturnPercent, months) {
  const pmt = toNum(monthlyInvestment);
  const r = toNum(annualReturnPercent) / 100 / 12;
  const n = Math.max(1, Math.round(toNum(months, 12)));
  if (r === 0) return pmt * n;
  return pmt * (((1 + r) ** n - 1) / r) * (1 + r);
}

export function swpCorpus(monthlyWithdrawal, annualReturnPercent, years) {
  const monthly = toNum(monthlyWithdrawal);
  const r = toNum(annualReturnPercent) / 100 / 12;
  const n = Math.max(1, Math.round(toNum(years, 10) * 12));
  if (r === 0) return monthly * n;
  return monthly * ((1 - (1 + r) ** -n) / r);
}

export function lumpsumFutureValue(amount, annualReturnPercent, years) {
  const p = toNum(amount);
  const r = toNum(annualReturnPercent) / 100;
  const t = toNum(years, 1);
  if (r === 0) return p;
  return p * ((1 + r) ** t);
}

export function fdMaturity(principal, annualRate, years, compounding = 4) {
  const p = toNum(principal);
  const r = toNum(annualRate) / 100;
  const n = Math.max(1, toNum(compounding, 4));
  const t = toNum(years, 1);
  return p * ((1 + r / n) ** (n * t));
}

export function rdMaturity(monthlyDeposit, annualRate, months) {
  const pmt = toNum(monthlyDeposit);
  const r = toNum(annualRate) / 100 / 12;
  const n = Math.max(1, Math.round(toNum(months, 12)));
  if (r === 0) return pmt * n;
  return pmt * (((1 + r) ** n - 1) / r) * (1 + r);
}

export function ppfMaturity(annualDeposit, annualRate, years) {
  const yearly = toNum(annualDeposit);
  const r = toNum(annualRate) / 100;
  const t = Math.max(1, Math.round(toNum(years, 15)));
  if (r === 0) return yearly * t;
  return yearly * (((1 + r) ** t - 1) / r) * (1 + r);
}

export function compoundInterest(principal, annualRate, years, frequency = 1) {
  const p = toNum(principal);
  const r = toNum(annualRate) / 100;
  const n = Math.max(1, toNum(frequency, 1));
  const t = toNum(years, 1);
  const amount = p * ((1 + r / n) ** (n * t));
  return { amount: round2(amount), interest: round2(amount - p) };
}

export function inflationAdjustedValue(futureValue, inflationRate, years) {
  const fv = toNum(futureValue);
  const inf = toNum(inflationRate) / 100;
  const t = toNum(years, 1);
  return round2(fv / ((1 + inf) ** t));
}

export function retirementCorpus(monthlyExpense, inflationRate, yearsToRetirement, postRetirementYears, returnRate) {
  const expense = toNum(monthlyExpense);
  const inf = toNum(inflationRate) / 100;
  const preYears = toNum(yearsToRetirement, 20);
  const postYears = toNum(postRetirementYears, 25);
  const ret = toNum(returnRate, 8) / 100;

  const expenseAtRetirement = expense * 12 * ((1 + inf) ** preYears);
  const monthlyPost = expenseAtRetirement / 12;
  const corpus = swpCorpus(monthlyPost, ret * 100, postYears);
  const monthlySipNeeded = corpus / (((((1 + ret / 12) ** (preYears * 12)) - 1) / (ret / 12)) * (1 + ret / 12) || 1);

  return {
    corpusRequired: round2(corpus),
    monthlyExpenseAtRetirement: round2(monthlyPost),
    monthlySipNeeded: round2(monthlySipNeeded),
    annualExpenseAtRetirement: round2(expenseAtRetirement),
  };
}

export function pensionPayout(corpus, annualRate, payoutYears) {
  const c = toNum(corpus);
  const monthly = c / Math.max(1, toNum(payoutYears, 20) * 12);
  const annuityMonthly = swpCorpus(monthly, annualRate, payoutYears) > 0 ? monthly : 0;
  return {
    monthlyPension: round2(monthly),
    annualPension: round2(monthly * 12),
    corpus: round2(c),
  };
}

export function npsProjection(age, retirementAge, monthlyContribution, employerContribution, expectedReturn) {
  const years = Math.max(1, toNum(retirementAge, 60) - toNum(age, 30));
  const monthly = toNum(monthlyContribution) + toNum(employerContribution);
  const fv = sipFutureValue(monthly, toNum(expectedReturn, 10), years * 12);
  const lumpsum60 = round2(fv * 0.6);
  const annuity40 = round2(fv * 0.4);
  const monthlyPension = round2(annuity40 / (20 * 12));
  return {
    totalCorpus: round2(fv),
    lumpsumWithdrawal: lumpsum60,
    annuityCorpus: annuity40,
    estimatedMonthlyPension: monthlyPension,
    contributionYears: years,
  };
}

export function annuityPayout(principal, annualRate, payoutYears) {
  const p = toNum(principal);
  const r = toNum(annualRate) / 100 / 12;
  const n = Math.max(1, Math.round(toNum(payoutYears, 20) * 12));
  let monthly = p / n;
  if (r > 0) monthly = (p * r) / (1 - (1 + r) ** -n);
  return {
    monthlyPayout: round2(monthly),
    annualPayout: round2(monthly * 12),
    totalPayout: round2(monthly * n),
  };
}

export function gstAmount(amount, gstRate, inclusive = false) {
  const base = toNum(amount);
  const rate = toNum(gstRate, 18) / 100;
  if (inclusive) {
    const taxable = base / (1 + rate);
    const gst = base - taxable;
    return { taxableValue: round2(taxable), gstAmount: round2(gst), total: round2(base) };
  }
  const gst = base * rate;
  return { taxableValue: round2(base), gstAmount: round2(gst), total: round2(base + gst) };
}

export function incomeTaxOldRegime(annualIncome, deductions = 0) {
  const taxable = Math.max(0, toNum(annualIncome) - toNum(deductions));
  let tax = 0;
  const slabs = [
    [250000, 0],
    [500000, 0.05],
    [1000000, 0.2],
    [Infinity, 0.3],
  ];
  let prev = 0;
  for (const [limit, rate] of slabs) {
    const chunk = Math.min(taxable, limit) - prev;
    if (chunk <= 0) break;
    tax += chunk * rate;
    prev = limit;
    if (taxable <= limit) break;
  }
  const cess = tax * 0.04;
  return { taxableIncome: round2(taxable), taxBeforeCess: round2(tax), cess: round2(cess), totalTax: round2(tax + cess) };
}

export function incomeTaxNewRegime(annualIncome) {
  const taxable = Math.max(0, toNum(annualIncome));
  let tax = 0;
  const slabs = [
    [300000, 0],
    [700000, 0.05],
    [1000000, 0.1],
    [1200000, 0.15],
    [1500000, 0.2],
    [Infinity, 0.3],
  ];
  let prev = 0;
  for (const [limit, rate] of slabs) {
    const chunk = Math.min(taxable, limit) - prev;
    if (chunk <= 0) break;
    tax += chunk * rate;
    prev = limit;
    if (taxable <= limit) break;
  }
  const cess = tax * 0.04;
  return { taxableIncome: round2(taxable), taxBeforeCess: round2(tax), cess: round2(cess), totalTax: round2(tax + cess) };
}

export function hraExemption(basicSalary, hraReceived, rentPaid, metro = true) {
  const basic = toNum(basicSalary);
  const hra = toNum(hraReceived);
  const rent = toNum(rentPaid);
  const pct = metro ? 0.5 : 0.4;
  const opt1 = hra;
  const opt2 = rent - basic * 0.1;
  const opt3 = basic * pct;
  const exempt = Math.max(0, Math.min(opt1, opt2, opt3));
  return {
    hraExempt: round2(exempt),
    taxableHra: round2(Math.max(0, hra - exempt)),
    options: { actualHra: round2(opt1), rentMinus10Basic: round2(opt2), percentOfBasic: round2(opt3) },
  };
}

export function capitalGain(purchasePrice, salePrice, holdingMonths, assetType = 'equity') {
  const gain = toNum(salePrice) - toNum(purchasePrice);
  const isLtcg = holdingMonths >= (assetType === 'equity' ? 12 : 24);
  let tax = 0;
  if (assetType === 'equity') {
    tax = isLtcg ? Math.max(0, gain - 125000) * 0.125 : gain * 0.2;
  } else {
    tax = isLtcg ? gain * 0.125 : gain * 0.3;
  }
  return {
    capitalGain: round2(gain),
    gainType: isLtcg ? 'LTCG' : 'STCG',
    estimatedTax: round2(Math.max(0, tax)),
    netGain: round2(gain - Math.max(0, tax)),
  };
}

export function loanEligibility(monthlyIncome, existingEmi, interestRate, tenureYears, foir = 0.5) {
  const income = toNum(monthlyIncome);
  const existing = toNum(existingEmi);
  const maxEmi = Math.max(0, income * foir - existing);
  const months = Math.max(1, Math.round(toNum(tenureYears, 20) * 12));
  const r = toNum(interestRate, 9) / 100 / 12;
  let eligible = maxEmi * months;
  if (r > 0) eligible = (maxEmi * ((1 + r) ** months - 1)) / (r * (1 + r) ** months);
  return { maxEmi: round2(maxEmi), eligibleLoanAmount: round2(eligible), foirPercent: foir * 100 };
}

export function debtConsolidation(loans, newRate, newTenureYears) {
  const list = Array.isArray(loans) ? loans : [];
  const totalPrincipal = list.reduce((s, l) => s + toNum(l?.principal || l?.balance), 0);
  const totalEmi = list.reduce((s, l) => s + toNum(l?.emi), 0);
  const consolidated = calculateEmi(totalPrincipal, newRate, newTenureYears * 12);
  return {
    currentTotalEmi: round2(totalEmi),
    consolidatedEmi: consolidated.emi,
    monthlySavings: round2(totalEmi - consolidated.emi),
    totalPrincipal: round2(totalPrincipal),
    ...consolidated,
  };
}

export function netWorth(assets, liabilities) {
  const a = toNum(assets);
  const l = toNum(liabilities);
  return { totalAssets: round2(a), totalLiabilities: round2(l), netWorth: round2(a - l) };
}

export function goalSip(goalAmount, years, expectedReturn) {
  const fv = toNum(goalAmount);
  const months = Math.max(1, Math.round(toNum(years, 10) * 12));
  const r = toNum(expectedReturn, 12) / 100 / 12;
  let sip = fv / months;
  if (r > 0) sip = (fv * r) / (((1 + r) ** months - 1) * (1 + r));
  return { monthlySipRequired: round2(sip), goalAmount: round2(fv), tenureMonths: months };
}

export function cagr(beginValue, endValue, years) {
  const b = toNum(beginValue);
  const e = toNum(endValue);
  const t = toNum(years, 1);
  if (b <= 0 || t <= 0) return { cagrPercent: 0 };
  const cagr = ((e / b) ** (1 / t) - 1) * 100;
  return { cagrPercent: round2(cagr) };
}

export function gratuity(basicSalary, yearsOfService, isCovered = true) {
  const basic = toNum(basicSalary);
  const years = toNum(yearsOfService);
  const factor = isCovered ? 15 / 26 : 0.5;
  const amount = basic * years * factor;
  return { gratuityAmount: round2(amount) };
}

export function epfCorpus(monthlyBasic, employeePct, employerPct, annualIncrease, years, epfRate) {
  let balance = 0;
  let monthly = toNum(monthlyBasic) * (toNum(employeePct, 12) + toNum(employerPct, 12)) / 100;
  const months = Math.max(1, Math.round(toNum(years, 20) * 12));
  const r = toNum(epfRate, 8.25) / 100 / 12;
  for (let i = 0; i < months; i += 1) {
    balance = balance * (1 + r) + monthly;
    if (i > 0 && i % 12 === 0) monthly *= 1 + toNum(annualIncrease, 5) / 100;
  }
  return { epfCorpus: round2(balance), monthlyContribution: round2(monthly) };
}

export function fireNumber(annualExpense, withdrawalRate = 4) {
  const expense = toNum(annualExpense);
  const wr = toNum(withdrawalRate, 4) / 100;
  return { fireCorpus: round2(expense / wr), annualExpense: round2(expense) };
}

export function rentVsBuy(rent, homePrice, downPayment, loanRate, tenureYears, appreciation) {
  const emi = calculateEmi(homePrice - downPayment, loanRate, tenureYears * 12);
  const rentTotal = rent * 12 * tenureYears;
  const buyTotal = downPayment + emi.totalPayment;
  const futureHome = lumpsumFutureValue(homePrice, appreciation, tenureYears);
  return {
    totalRentCost: round2(rentTotal),
    totalBuyCost: round2(buyTotal),
    estimatedHomeValue: round2(futureHome),
    monthlyEmi: emi.emi,
    recommendation: buyTotal < rentTotal ? 'Buy may be preferable' : 'Rent may be preferable (illustrative)',
  };
}
