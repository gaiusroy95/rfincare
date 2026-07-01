/** Canonical credit card marketplace categories and comparison filters. */

export const CREDIT_CARD_CATEGORIES = [
  { slug: 'cashback', label: 'Cashback Cards', icon: 'Percent' },
  { slug: 'travel', label: 'Travel Cards', icon: 'Plane' },
  { slug: 'fuel', label: 'Fuel Cards', icon: 'Fuel' },
  { slug: 'airport_lounge', label: 'Airport Lounge Cards', icon: 'Armchair' },
  { slug: 'shopping', label: 'Shopping Cards', icon: 'ShoppingBag' },
  { slug: 'premium', label: 'Premium Cards', icon: 'Crown' },
  { slug: 'business', label: 'Business Cards', icon: 'Briefcase' },
  { slug: 'student', label: 'Student Cards', icon: 'GraduationCap' },
  { slug: 'secured', label: 'Secured Credit Cards', icon: 'Lock' },
  { slug: 'rupay', label: 'RuPay Credit Cards', icon: 'CreditCard' },
  { slug: 'upi', label: 'UPI Credit Cards', icon: 'Smartphone' },
  { slug: 'co_branded', label: 'Co-branded Credit Cards', icon: 'Handshake' },
];

export const CREDIT_CARD_CATEGORY_SLUGS = CREDIT_CARD_CATEGORIES.map((c) => c.slug);

export const CREDIT_CARD_COMPARISON_FILTERS = [
  { key: 'annualFee', label: 'Annual Fee', type: 'fee_range', field: 'annualFee' },
  { key: 'joiningFee', label: 'Joining Fee', type: 'fee_range', field: 'joiningFee' },
  { key: 'rewardPoints', label: 'Reward Points', type: 'boolean', field: 'hasRewardPoints' },
  { key: 'loungeAccess', label: 'Lounge Access', type: 'boolean', field: 'loungeAccess' },
  { key: 'fuelSurchargeWaiver', label: 'Fuel Surcharge Waiver', type: 'boolean', field: 'fuelSurchargeWaiver' },
  { key: 'movieBenefits', label: 'Movie Benefits', type: 'boolean', field: 'movieBenefits' },
  { key: 'diningBenefits', label: 'Dining Benefits', type: 'boolean', field: 'diningBenefits' },
  { key: 'insuranceCover', label: 'Insurance Cover', type: 'boolean', field: 'insuranceCover' },
  { key: 'forexCharges', label: 'Forex Charges', type: 'forex', field: 'forexCharges' },
  { key: 'emiConversion', label: 'EMI Conversion', type: 'boolean', field: 'emiConversion' },
];

export const ANNUAL_FEE_FILTER_OPTIONS = [
  { value: 'all', label: 'Any annual fee' },
  { value: 'free', label: 'Lifetime free (₹0)' },
  { value: '0-500', label: 'Up to ₹500' },
  { value: '500-2500', label: '₹500 – ₹2,500' },
  { value: '2500+', label: 'Above ₹2,500' },
];

export const JOINING_FEE_FILTER_OPTIONS = [
  { value: 'all', label: 'Any joining fee' },
  { value: 'free', label: 'No joining fee' },
  { value: '0-500', label: 'Up to ₹500' },
  { value: '500+', label: 'Above ₹500' },
];

export const FOREX_CHARGES_FILTER_OPTIONS = [
  { value: 'all', label: 'Any forex charges' },
  { value: 'zero', label: 'Zero / no markup' },
  { value: 'under_2', label: 'Under 2%' },
  { value: 'under_3', label: 'Under 3%' },
];

export function getCreditCardTaxonomy() {
  return {
    categories: CREDIT_CARD_CATEGORIES,
    comparisonFilters: CREDIT_CARD_COMPARISON_FILTERS,
    annualFeeOptions: ANNUAL_FEE_FILTER_OPTIONS,
    joiningFeeOptions: JOINING_FEE_FILTER_OPTIONS,
    forexChargesOptions: FOREX_CHARGES_FILTER_OPTIONS,
  };
}

export function normalizeCategoryList(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const allowed = new Set(CREDIT_CARD_CATEGORY_SLUGS);
  return [...new Set(raw.map((s) => String(s).trim()).filter((s) => allowed.has(s)))];
}
