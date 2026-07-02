/** Government schemes marketplace taxonomy. */

export const GOVERNMENT_SCHEME_CATEGORIES = [
  { slug: 'pm_mudra', label: 'PM Mudra', icon: 'Briefcase' },
  { slug: 'pmegp', label: 'PMEGP', icon: 'Factory' },
  { slug: 'stand_up_india', label: 'Stand-Up India', icon: 'Handshake' },
  { slug: 'startup_india', label: 'Startup India', icon: 'Rocket' },
  { slug: 'atal_pension_yojana', label: 'Atal Pension Yojana', icon: 'Heart' },
  { slug: 'nps', label: 'NPS', icon: 'Landmark' },
  { slug: 'pmjjby', label: 'PMJJBY', icon: 'Shield' },
  { slug: 'pmsby', label: 'PMSBY', icon: 'Umbrella' },
  { slug: 'ayushman_bharat', label: 'Ayushman Bharat', icon: 'Stethoscope' },
  { slug: 'solar_subsidy', label: 'Solar Subsidy', icon: 'Sun' },
  { slug: 'msme_subsidies', label: 'MSME Subsidies', icon: 'Building2' },
  { slug: 'agriculture_subsidies', label: 'Agriculture Subsidies', icon: 'Wheat' },
];

export const GOVERNMENT_SCHEME_CATEGORY_SLUGS = GOVERNMENT_SCHEME_CATEGORIES.map((c) => c.slug);

export const COMPARISON_ATTRIBUTES = [
  { key: 'eligibilityText', label: 'Eligibility', field: 'eligibilityText' },
  { key: 'benefitsText', label: 'Benefits', field: 'benefitsText' },
  { key: 'loanAmount', label: 'Loan / Subsidy', field: 'loanAmount' },
  { key: 'interestRate', label: 'Interest Rate', field: 'interestRate' },
  { key: 'subsidyPercent', label: 'Subsidy %', field: 'subsidyPercent' },
];

export function getGovernmentSchemeTaxonomy() {
  return {
    categories: GOVERNMENT_SCHEME_CATEGORIES,
    comparisonAttributes: COMPARISON_ATTRIBUTES,
  };
}

export function normalizeCategoryList(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const allowed = new Set(GOVERNMENT_SCHEME_CATEGORY_SLUGS);
  return [...new Set(raw.map((s) => String(s).trim()).filter((s) => allowed.has(s)))];
}

export function getCategoryLabel(slug) {
  return GOVERNMENT_SCHEME_CATEGORIES.find((c) => c.slug === slug)?.label || slug;
}
