/**
 * Registry of 50+ financial calculators — metadata for API + clients.
 * Each entry maps to an engine in runCalculator().
 */

export const CALCULATOR_CATEGORIES = [
  { id: 'loans', label: 'Loan Calculators' },
  { id: 'investments', label: 'Investment Calculators' },
  { id: 'tax', label: 'Tax Calculators' },
  { id: 'retirement', label: 'Retirement Planning' },
  { id: 'goals', label: 'Goal & Wealth Planning' },
  { id: 'savings', label: 'Savings & Deposits' },
  { id: 'other', label: 'Other Tools' },
];

const loanDefaults = { principal: 1000000, annualRate: 9.5, tenureMonths: 240 };

function entry(slug, title, category, engine, description, defaults = {}, tags = []) {
  return { slug, title, category, engine, description, defaults, tags };
}

export const CALCULATOR_REGISTRY = [
  // Loans
  entry('emi', 'EMI Calculator', 'loans', 'emi', 'Calculate monthly EMI, total interest and repayment.', loanDefaults, ['emi', 'loan']),
  entry('home-loan', 'Home Loan Calculator', 'loans', 'emi', 'Estimate EMI for home loans.', { ...loanDefaults, principal: 5000000, tenureMonths: 240 }, ['home']),
  entry('car-loan', 'Car Loan Calculator', 'loans', 'emi', 'Estimate EMI for car loans.', { ...loanDefaults, principal: 800000, tenureMonths: 60 }, ['car']),
  entry('business-loan', 'Business Loan Calculator', 'loans', 'emi', 'Estimate EMI for business loans.', { ...loanDefaults, principal: 2000000, tenureMonths: 48 }, ['business']),
  entry('education-loan', 'Education Loan Calculator', 'loans', 'emi', 'Estimate EMI for education loans.', { ...loanDefaults, principal: 1500000, tenureMonths: 84 }, ['education']),
  entry('personal-loan', 'Personal Loan Calculator', 'loans', 'emi', 'Estimate EMI for personal loans.', { ...loanDefaults, principal: 500000, tenureMonths: 36 }, ['personal']),
  entry('credit-card-emi', 'Credit Card EMI Calculator', 'loans', 'emi', 'Convert card outstanding to EMI.', { principal: 50000, annualRate: 18, tenureMonths: 12 }, ['credit card']),
  entry('loan-eligibility', 'Loan Eligibility Calculator', 'loans', 'loan-eligibility', 'Check eligible loan amount based on income.', { monthlyIncome: 75000, existingEmi: 10000, interestRate: 9.5, tenureYears: 20 }, ['eligibility']),
  entry('debt-consolidation', 'Debt Consolidation Calculator', 'loans', 'debt-consolidation', 'Compare consolidating multiple loans.', { loans: [{ principal: 200000, emi: 6500 }, { principal: 150000, emi: 4800 }], newRate: 11, newTenureYears: 5 }, ['debt']),
  entry('loan-prepayment', 'Loan Prepayment Calculator', 'loans', 'loan-prepayment', 'See impact of partial prepayment on loan.', { ...loanDefaults, prepayment: 100000, afterMonths: 24 }),
  entry('balance-transfer', 'Balance Transfer Calculator', 'loans', 'balance-transfer', 'Compare balance transfer savings.', { outstanding: 500000, currentRate: 14, newRate: 10.5, tenureMonths: 36 }),

  // Investments
  entry('sip', 'SIP Calculator', 'investments', 'sip', 'Project mutual fund SIP returns.', { monthlyInvestment: 10000, expectedReturn: 12, tenureYears: 10 }, ['sip', 'mutual fund']),
  entry('step-up-sip', 'Step-up SIP Calculator', 'investments', 'step-up-sip', 'SIP with annual increment.', { monthlyInvestment: 5000, stepUpPercent: 10, expectedReturn: 12, tenureYears: 15 }),
  entry('swp', 'SWP Calculator', 'investments', 'swp', 'Systematic withdrawal plan corpus estimate.', { monthlyWithdrawal: 25000, expectedReturn: 8, tenureYears: 25 }, ['swp']),
  entry('lumpsum', 'Lumpsum Calculator', 'investments', 'lumpsum', 'Project lumpsum investment growth.', { amount: 500000, expectedReturn: 12, tenureYears: 10 }),
  entry('compound-interest', 'Compound Interest Calculator', 'investments', 'compound-interest', 'Compound interest on savings.', { principal: 100000, annualRate: 8, years: 10, compoundingFrequency: 4 }),
  entry('cagr', 'CAGR Calculator', 'investments', 'cagr', 'Compound annual growth rate.', { beginValue: 100000, endValue: 250000, years: 5 }),
  entry('mutual-fund-returns', 'Mutual Fund Returns Calculator', 'investments', 'sip', 'SIP or lumpsum MF returns.', { monthlyInvestment: 5000, expectedReturn: 12, tenureYears: 10 }),
  entry('gold-investment', 'Gold Investment Calculator', 'investments', 'lumpsum', 'Project gold investment value.', { amount: 200000, expectedReturn: 8, tenureYears: 10 }),
  entry('bond-yield', 'Bond Yield Calculator', 'investments', 'bond-yield', 'Estimate bond yield to maturity.', { faceValue: 1000, couponRate: 7, years: 5, marketPrice: 980 }),

  // Savings & deposits
  entry('fd', 'FD Calculator', 'savings', 'fd', 'Fixed deposit maturity value.', { principal: 500000, annualRate: 7.5, years: 5 }),
  entry('tax-saving-fd', 'Tax Saving FD Calculator', 'savings', 'fd', '5-year tax-saving FD maturity.', { principal: 150000, annualRate: 7, years: 5 }, ['80c']),
  entry('rd', 'RD Calculator', 'savings', 'rd', 'Recurring deposit maturity.', { monthlyDeposit: 5000, annualRate: 7, months: 60 }),
  entry('ppf', 'PPF Calculator', 'savings', 'ppf', 'Public Provident Fund maturity.', { annualDeposit: 150000, annualRate: 7.1, years: 15 }),
  entry('nsc', 'NSC Calculator', 'savings', 'fd', 'National Savings Certificate maturity.', { principal: 100000, annualRate: 7.7, years: 5 }),
  entry('scss', 'SCSS Calculator', 'savings', 'fd', 'Senior Citizen Savings Scheme.', { principal: 500000, annualRate: 8.2, years: 5 }),
  entry('ssy', 'Sukanya Samriddhi Calculator', 'savings', 'ppf', 'SSY account maturity projection.', { annualDeposit: 100000, annualRate: 8.2, years: 15 }),

  // Tax
  entry('income-tax', 'Income Tax Calculator', 'tax', 'income-tax', 'Compare old vs new tax regime.', { annualIncome: 1200000, deductions: 150000, regime: 'both' }),
  entry('hra', 'HRA Calculator', 'tax', 'hra', 'House Rent Allowance exemption.', { basicSalary: 50000, hraReceived: 20000, rentPaid: 18000, metro: true }),
  entry('capital-gain', 'Capital Gain Calculator', 'tax', 'capital-gain', 'LTCG/STCG tax estimate.', { purchasePrice: 100000, salePrice: 180000, holdingMonths: 18, assetType: 'equity' }),
  entry('gst', 'GST Calculator', 'tax', 'gst', 'GST inclusive/exclusive amounts.', { amount: 10000, gstRate: 18, inclusive: false }),
  entry('tds', 'TDS Calculator', 'tax', 'tds', 'Tax deducted at source estimate.', { amount: 100000, tdsRate: 10 }),
  entry('section-80c', 'Section 80C Calculator', 'tax', 'section-80c', '80C deduction limit utilisation.', { ppf: 150000, elss: 50000, epf: 80000, lifeInsurance: 25000 }),
  entry('section-80d', 'Section 80D Calculator', 'tax', 'section-80d', 'Health insurance 80D deduction.', { selfPremium: 25000, parentsPremium: 30000, parentsSenior: true }),
  entry('advance-tax', 'Advance Tax Calculator', 'tax', 'advance-tax', 'Quarterly advance tax estimate.', { annualIncome: 2000000, tdsPaid: 100000 }),

  // Retirement
  entry('retirement-corpus', 'Retirement Corpus Planner', 'retirement', 'retirement-corpus', 'Plan retirement corpus and SIP needed.', { monthlyExpense: 50000, inflationRate: 6, yearsToRetirement: 25, postRetirementYears: 25, returnRate: 10 }),
  entry('pension', 'Pension Calculator', 'retirement', 'pension', 'Monthly pension from retirement corpus.', { corpus: 20000000, annualRate: 7, payoutYears: 25 }),
  entry('nps', 'NPS Calculator', 'retirement', 'nps', 'National Pension System projection.', { age: 30, retirementAge: 60, monthlyContribution: 5000, employerContribution: 5000, expectedReturn: 10 }),
  entry('annuity', 'Annuity Calculator', 'retirement', 'annuity', 'Annuity payout from lump sum.', { principal: 5000000, annualRate: 7, payoutYears: 20 }),
  entry('retirement', 'Retirement Calculator', 'retirement', 'retirement-corpus', 'Comprehensive retirement planning.', { monthlyExpense: 40000, inflationRate: 6, yearsToRetirement: 20, postRetirementYears: 20, returnRate: 9 }),
  entry('epf', 'EPF Calculator', 'retirement', 'epf', 'Employee Provident Fund corpus.', { monthlyBasic: 30000, employeePct: 12, employerPct: 12, annualIncrease: 5, years: 25, epfRate: 8.25 }),
  entry('gratuity', 'Gratuity Calculator', 'retirement', 'gratuity', 'Gratuity benefit estimate.', { basicSalary: 45000, yearsOfService: 15, isCovered: true }),

  // Goals & wealth
  entry('goal-sip', 'Goal SIP Calculator', 'goals', 'goal-sip', 'Monthly SIP needed for a financial goal.', { goalAmount: 5000000, years: 15, expectedReturn: 12 }),
  entry('child-education', 'Child Education Planning', 'goals', 'goal-sip', 'Plan SIP for child education.', { goalAmount: 3000000, years: 12, expectedReturn: 11 }),
  entry('marriage-planning', 'Marriage Planning Calculator', 'goals', 'goal-sip', 'Plan SIP for marriage expenses.', { goalAmount: 2500000, years: 8, expectedReturn: 10 }),
  entry('wealth-creation', 'Wealth Creation Calculator', 'goals', 'sip', 'Long-term wealth creation via SIP.', { monthlyInvestment: 15000, expectedReturn: 12, tenureYears: 20 }),
  entry('net-worth', 'Net Worth Calculator', 'goals', 'net-worth', 'Calculate personal net worth.', { assets: 5000000, liabilities: 1500000 }),
  entry('fire', 'FIRE Calculator', 'goals', 'fire', 'Financial independence corpus.', { annualExpense: 1200000, withdrawalRate: 4 }),
  entry('inflation', 'Inflation Calculator', 'goals', 'inflation', 'Future value adjusted for inflation.', { futureValue: 1000000, inflationRate: 6, years: 10 }),
  entry('affordability', 'Affordability Calculator', 'goals', 'affordability', 'What home price can you afford?', { monthlyIncome: 100000, existingEmi: 15000, downPayment: 1000000, interestRate: 9, tenureYears: 20 }),
  entry('rent-vs-buy', 'Rent vs Buy Calculator', 'goals', 'rent-vs-buy', 'Compare renting vs buying a home.', { rent: 25000, homePrice: 6000000, downPayment: 1200000, loanRate: 9, tenureYears: 20, appreciation: 6 }),

  // Other
  entry('stamp-duty', 'Stamp Duty Calculator', 'other', 'stamp-duty', 'Property stamp duty estimate.', { propertyValue: 5000000, stampDutyPercent: 5 }),
  entry('property-registration', 'Property Registration Calculator', 'other', 'property-registration', 'Registration charges estimate.', { propertyValue: 5000000, registrationPercent: 1 }),
  entry('salary-breakup', 'Salary Breakup Calculator', 'other', 'salary-breakup', 'CTC to in-hand salary estimate.', { ctc: 1500000, basicPercent: 40 }),
  entry('breakeven', 'Breakeven Calculator', 'other', 'breakeven', 'Business breakeven analysis.', { fixedCost: 500000, variableCostPerUnit: 200, pricePerUnit: 500 }),
];

export function getCalculatorBySlug(slug) {
  return CALCULATOR_REGISTRY.find((c) => c.slug === slug) || null;
}

export function listCalculators({ category } = {}) {
  let list = [...CALCULATOR_REGISTRY];
  if (category) list = list.filter((c) => c.category === category);
  return list.map(({ slug, title, category: cat, description, tags }) => ({
    slug,
    title,
    category: cat,
    description,
    tags,
  }));
}
