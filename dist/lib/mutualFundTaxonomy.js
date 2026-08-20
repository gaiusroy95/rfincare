const MUTUAL_FUND_CATEGORIES = [
  { slug: "sip", label: "SIP", icon: "CalendarClock" },
  { slug: "lumpsum", label: "Lumpsum", icon: "IndianRupee" },
  { slug: "elss", label: "ELSS", icon: "Receipt" },
  { slug: "debt_funds", label: "Debt Funds", icon: "Landmark" },
  { slug: "liquid_funds", label: "Liquid Funds", icon: "Droplets" },
  { slug: "hybrid_funds", label: "Hybrid Funds", icon: "Blend" },
  { slug: "flexi_cap", label: "Flexi Cap", icon: "Shuffle" },
  { slug: "mid_cap", label: "Mid Cap", icon: "TrendingUp" },
  { slug: "small_cap", label: "Small Cap", icon: "Rocket" },
  { slug: "large_cap", label: "Large Cap", icon: "Building2" },
  { slug: "index_funds", label: "Index Funds", icon: "BarChart3" },
  { slug: "etf", label: "ETF", icon: "LineChart" },
  { slug: "international_funds", label: "International Funds", icon: "Globe" }
];
const MUTUAL_FUND_CATEGORY_SLUGS = MUTUAL_FUND_CATEGORIES.map((c) => c.slug);
const RISK_LEVELS = [
  { slug: "low", label: "Low" },
  { slug: "low_to_moderate", label: "Low to Moderate" },
  { slug: "moderate", label: "Moderate" },
  { slug: "moderately_high", label: "Moderately High" },
  { slug: "high", label: "High" },
  { slug: "very_high", label: "Very High" }
];
const RETURNS_PERIOD_OPTIONS = [
  { value: "all", label: "Any returns" },
  { value: "1y_10+", label: "1Y returns above 10%" },
  { value: "1y_15+", label: "1Y returns above 15%" },
  { value: "3y_12+", label: "3Y returns above 12%" },
  { value: "5y_12+", label: "5Y returns above 12%" }
];
const EXPENSE_RATIO_OPTIONS = [
  { value: "all", label: "Any expense ratio" },
  { value: "0-0.5", label: "Up to 0.5%" },
  { value: "0.5-1", label: "0.5% – 1%" },
  { value: "1-1.5", label: "1% – 1.5%" },
  { value: "1.5+", label: "Above 1.5%" }
];
const RATING_FILTER_OPTIONS = [
  { value: "all", label: "Any rating" },
  { value: "4+", label: "4★ and above" },
  { value: "4.5+", label: "4.5★ and above" },
  { value: "5", label: "5★ only" }
];
const COMPARISON_ATTRIBUTES = [
  { key: "returns1y", label: "1Y Returns", field: "returns1y" },
  { key: "returns3y", label: "3Y Returns", field: "returns3y" },
  { key: "returns5y", label: "5Y Returns", field: "returns5y" },
  { key: "riskLevel", label: "Risk", field: "riskLevel" },
  { key: "expenseRatio", label: "Expense Ratio", field: "expenseRatio" },
  { key: "fundManager", label: "Fund Manager", field: "fundManager" },
  { key: "aumCrores", label: "AUM", field: "aumCrores" },
  { key: "rating", label: "Rating", field: "rating" }
];
function getMutualFundTaxonomy() {
  return {
    categories: MUTUAL_FUND_CATEGORIES,
    riskLevels: RISK_LEVELS,
    returnsPeriodOptions: RETURNS_PERIOD_OPTIONS,
    expenseRatioOptions: EXPENSE_RATIO_OPTIONS,
    ratingOptions: RATING_FILTER_OPTIONS,
    comparisonAttributes: COMPARISON_ATTRIBUTES
  };
}
function normalizeCategoryList(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const allowed = new Set(MUTUAL_FUND_CATEGORY_SLUGS);
  return [...new Set(raw.map((s) => String(s).trim()).filter((s) => allowed.has(s)))];
}
function getCategoryLabel(slug) {
  return MUTUAL_FUND_CATEGORIES.find((c) => c.slug === slug)?.label || slug;
}
function getRiskLabel(slug) {
  return RISK_LEVELS.find((r) => r.slug === slug)?.label || slug;
}
export {
  COMPARISON_ATTRIBUTES,
  EXPENSE_RATIO_OPTIONS,
  MUTUAL_FUND_CATEGORIES,
  MUTUAL_FUND_CATEGORY_SLUGS,
  RATING_FILTER_OPTIONS,
  RETURNS_PERIOD_OPTIONS,
  RISK_LEVELS,
  getCategoryLabel,
  getMutualFundTaxonomy,
  getRiskLabel,
  normalizeCategoryList
};
