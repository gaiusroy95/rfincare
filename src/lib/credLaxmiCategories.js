/**
 * CredLaxmi spend category master (household / business / special).
 */

export const CREDLAXMI_CATEGORIES = [
  // Household / Personal
  { code: 'GROCERIES', label: 'Groceries', expenseType: 'HOUSEHOLD', isRewardEligible: true },
  { code: 'DINING_FOOD', label: 'Dining & Food Delivery', expenseType: 'HOUSEHOLD', isRewardEligible: true },
  { code: 'UTILITIES_BILLS', label: 'Utilities / Bills', expenseType: 'HOUSEHOLD', isRewardEligible: true },
  { code: 'FUEL', label: 'Fuel', expenseType: 'HOUSEHOLD', isRewardEligible: true },
  { code: 'TRAVEL_FLIGHTS', label: 'Travel & Flights', expenseType: 'HOUSEHOLD', isRewardEligible: true },
  { code: 'ONLINE_SHOPPING', label: 'Online Shopping', expenseType: 'HOUSEHOLD', isRewardEligible: true },
  // Business / Commercial
  { code: 'VENDOR_PAYMENTS', label: 'Vendor Payments', expenseType: 'BUSINESS', isRewardEligible: true },
  { code: 'OFFICE_SUPPLIES', label: 'Office Supplies', expenseType: 'BUSINESS', isRewardEligible: true },
  { code: 'ADVERTISING_SOFTWARE', label: 'Advertising & Software', expenseType: 'BUSINESS', isRewardEligible: true },
  { code: 'CLIENT_ENTERTAINMENT', label: 'Client Entertainment', expenseType: 'BUSINESS', isRewardEligible: true },
  { code: 'TRAVEL_LODGING', label: 'Travel & Lodging', expenseType: 'BUSINESS', isRewardEligible: true },
  // Special (often zero / low rewards)
  { code: 'RENT', label: 'Rent', expenseType: 'SPECIAL', isRewardEligible: false },
  { code: 'EDUCATION', label: 'Education', expenseType: 'SPECIAL', isRewardEligible: false },
  { code: 'GOVT_TAXES', label: 'Government Taxes', expenseType: 'SPECIAL', isRewardEligible: false },
  { code: 'WALLET_LOAD', label: 'Wallet Loads', expenseType: 'SPECIAL', isRewardEligible: false },
  { code: 'MISC_BASE', label: 'Other / Base Spend', expenseType: 'SPECIAL', isRewardEligible: true },
];

export const CREDLAXMI_CATEGORY_CODES = new Set(CREDLAXMI_CATEGORIES.map((c) => c.code));

export function getCredLaxmiCategory(code) {
  return CREDLAXMI_CATEGORIES.find((c) => c.code === String(code || '').toUpperCase()) || null;
}

export function listCredLaxmiCategories({ expenseType } = {}) {
  if (!expenseType) return CREDLAXMI_CATEGORIES;
  const t = String(expenseType).toUpperCase();
  return CREDLAXMI_CATEGORIES.filter((c) => c.expenseType === t);
}
