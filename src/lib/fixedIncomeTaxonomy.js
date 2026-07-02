/** Canonical fixed income marketplace taxonomy. */

export const FIXED_INCOME_CATEGORIES = [
  { slug: 'fixed_deposits', label: 'Fixed Deposits', icon: 'Landmark' },
  { slug: 'corporate_fd', label: 'Corporate FD', icon: 'Building2' },
  { slug: 'nbfc_fd', label: 'NBFC FD', icon: 'Briefcase' },
  { slug: 'senior_citizen_fd', label: 'Senior Citizen FD', icon: 'HeartHandshake' },
  { slug: 'tax_saving_fd', label: 'Tax Saving FD', icon: 'Receipt' },
  { slug: 'recurring_deposit', label: 'Recurring Deposit', icon: 'Repeat' },
];

export const FIXED_INCOME_CATEGORY_SLUGS = FIXED_INCOME_CATEGORIES.map((c) => c.slug);

export const COMPARISON_ATTRIBUTES = [
  { key: 'interestRate', label: 'Interest Rate', field: 'interestRate' },
  { key: 'lockInMonths', label: 'Lock-in', field: 'lockInMonths' },
  { key: 'prematureWithdrawal', label: 'Premature Withdrawal', field: 'prematureWithdrawal' },
  { key: 'monthlyInterest', label: 'Monthly Interest', field: 'monthlyInterest' },
  { key: 'quarterlyInterest', label: 'Quarterly Interest', field: 'quarterlyInterest' },
];

export function getFixedIncomeTaxonomy() {
  return {
    categories: FIXED_INCOME_CATEGORIES,
    comparisonAttributes: COMPARISON_ATTRIBUTES,
  };
}

export function normalizeCategoryList(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const allowed = new Set(FIXED_INCOME_CATEGORY_SLUGS);
  return [...new Set(raw.map((s) => String(s).trim()).filter((s) => allowed.has(s)))];
}

export function getCategoryLabel(slug) {
  return FIXED_INCOME_CATEGORIES.find((c) => c.slug === slug)?.label || slug;
}

