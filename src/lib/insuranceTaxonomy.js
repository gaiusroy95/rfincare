/** Canonical insurance marketplace taxonomy. */

export const INSURANCE_SEGMENTS = [
  { slug: 'life', label: 'Life Insurance', icon: 'Heart' },
  { slug: 'health', label: 'Health Insurance', icon: 'Activity' },
  { slug: 'motor', label: 'Motor Insurance', icon: 'Car' },
];

export const INSURANCE_CATEGORIES = [
  // Life
  { slug: 'term_insurance', label: 'Term Insurance', segment: 'life', icon: 'Shield' },
  { slug: 'whole_life', label: 'Whole Life', segment: 'life', icon: 'Infinity' },
  { slug: 'endowment', label: 'Endowment', segment: 'life', icon: 'PiggyBank' },
  { slug: 'ulip', label: 'ULIP', segment: 'life', icon: 'TrendingUp' },
  { slug: 'child_plans', label: 'Child Plans', segment: 'life', icon: 'Baby' },
  { slug: 'retirement_plans', label: 'Retirement Plans', segment: 'life', icon: 'Sunset' },
  { slug: 'pension_plans', label: 'Pension Plans', segment: 'life', icon: 'Landmark' },
  { slug: 'guaranteed_income_plans', label: 'Guaranteed Income Plans', segment: 'life', icon: 'BadgeIndianRupee' },
  // Health
  { slug: 'individual', label: 'Individual', segment: 'health', icon: 'User' },
  { slug: 'family_floater', label: 'Family Floater', segment: 'health', icon: 'Users' },
  { slug: 'senior_citizen', label: 'Senior Citizen', segment: 'health', icon: 'HeartHandshake' },
  { slug: 'critical_illness', label: 'Critical Illness', segment: 'health', icon: 'Stethoscope' },
  { slug: 'cancer_cover', label: 'Cancer Cover', segment: 'health', icon: 'Ribbon' },
  { slug: 'diabetes_cover', label: 'Diabetes Cover', segment: 'health', icon: 'Droplet' },
  { slug: 'opd_plans', label: 'OPD Plans', segment: 'health', icon: 'ClipboardList' },
  { slug: 'maternity_plans', label: 'Maternity Plans', segment: 'health', icon: 'Baby' },
  { slug: 'personal_accident', label: 'Personal Accident', segment: 'health', icon: 'AlertTriangle' },
  // Motor
  { slug: 'car_insurance', label: 'Car Insurance', segment: 'motor', icon: 'Car' },
  { slug: 'bike_insurance', label: 'Bike Insurance', segment: 'motor', icon: 'Bike' },
  { slug: 'commercial_vehicle', label: 'Commercial Vehicle', segment: 'motor', icon: 'Truck' },
  { slug: 'taxi_insurance', label: 'Taxi Insurance', segment: 'motor', icon: 'CarTaxiFront' },
  { slug: 'ev_insurance', label: 'EV Insurance', segment: 'motor', icon: 'Zap' },
];

export const INSURANCE_CATEGORY_SLUGS = INSURANCE_CATEGORIES.map((c) => c.slug);

export const INSURANCE_SERVICES = [
  { slug: 'new_policy', label: 'New Policy', icon: 'FilePlus' },
  { slug: 'renewal', label: 'Renewal', icon: 'RefreshCw' },
  { slug: 'claim_assistance', label: 'Claim Assistance', icon: 'LifeBuoy' },
];

export const PREMIUM_FILTER_OPTIONS = [
  { value: 'all', label: 'Any premium' },
  { value: '0-5000', label: 'Up to ₹5,000/yr' },
  { value: '5000-15000', label: '₹5,000 – ₹15,000/yr' },
  { value: '15000-50000', label: '₹15,000 – ₹50,000/yr' },
  { value: '50000+', label: 'Above ₹50,000/yr' },
];

export const SUM_INSURED_FILTER_OPTIONS = [
  { value: 'all', label: 'Any sum insured' },
  { value: '0-500000', label: 'Up to ₹5 Lakh' },
  { value: '500000-2500000', label: '₹5 L – ₹25 L' },
  { value: '2500000-10000000', label: '₹25 L – ₹1 Cr' },
  { value: '10000000+', label: 'Above ₹1 Cr' },
];

export function getInsuranceTaxonomy() {
  return {
    segments: INSURANCE_SEGMENTS,
    categories: INSURANCE_CATEGORIES,
    services: INSURANCE_SERVICES,
    premiumOptions: PREMIUM_FILTER_OPTIONS,
    sumInsuredOptions: SUM_INSURED_FILTER_OPTIONS,
  };
}

export function normalizeCategoryList(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const allowed = new Set(INSURANCE_CATEGORY_SLUGS);
  return [...new Set(raw.map((s) => String(s).trim()).filter((s) => allowed.has(s)))];
}

export function getCategoriesForSegment(segment) {
  if (!segment || segment === 'all') return INSURANCE_CATEGORIES;
  return INSURANCE_CATEGORIES.filter((c) => c.segment === segment);
}

export function getCategoryLabel(slug) {
  return INSURANCE_CATEGORIES.find((c) => c.slug === slug)?.label || slug;
}

export function getSegmentLabel(slug) {
  return INSURANCE_SEGMENTS.find((s) => s.slug === slug)?.label || slug;
}
