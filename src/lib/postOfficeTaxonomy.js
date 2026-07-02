/** Post Office investment marketplace taxonomy. */

export const POST_OFFICE_CATEGORIES = [
  { slug: 'ppf', label: 'PPF', icon: 'PiggyBank' },
  { slug: 'nsc', label: 'NSC', icon: 'FileBadge' },
  { slug: 'kvp', label: 'KVP', icon: 'TrendingUp' },
  { slug: 'sukanya_samriddhi', label: 'Sukanya Samriddhi', icon: 'HeartHandshake' },
  { slug: 'senior_citizen_savings', label: 'Senior Citizen Savings Scheme', icon: 'Users' },
  { slug: 'monthly_income_scheme', label: 'Monthly Income Scheme', icon: 'Calendar' },
  { slug: 'time_deposit', label: 'Time Deposit', icon: 'Clock' },
  { slug: 'recurring_deposit', label: 'Recurring Deposit', icon: 'Repeat' },
];

export const POST_OFFICE_CATEGORY_SLUGS = POST_OFFICE_CATEGORIES.map((c) => c.slug);

export const COMPARISON_ATTRIBUTES = [
  { key: 'eligibilityText', label: 'Eligibility', field: 'eligibilityText' },
  { key: 'returnsSummary', label: 'Returns', field: 'returnsSummary' },
  { key: 'maturityValue', label: 'Maturity Value', field: 'maturityValue' },
  { key: 'taxBenefitsText', label: 'Tax Benefits', field: 'taxBenefitsText' },
];

export function getPostOfficeTaxonomy() {
  return {
    categories: POST_OFFICE_CATEGORIES,
    comparisonAttributes: COMPARISON_ATTRIBUTES,
    calculatorTypes: POST_OFFICE_CATEGORIES.map((c) => ({ slug: c.slug, label: c.label })),
  };
}

export function normalizeCategoryList(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const allowed = new Set(POST_OFFICE_CATEGORY_SLUGS);
  return [...new Set(raw.map((s) => String(s).trim()).filter((s) => allowed.has(s)))];
}

export function getCategoryLabel(slug) {
  return POST_OFFICE_CATEGORIES.find((c) => c.slug === slug)?.label || slug;
}
