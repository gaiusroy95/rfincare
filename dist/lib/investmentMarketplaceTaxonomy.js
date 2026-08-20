const INVESTMENT_CATEGORIES = [
  { slug: "sovereign_gold_bonds", label: "Sovereign Gold Bonds", icon: "Gem" },
  { slug: "digital_gold", label: "Digital Gold", icon: "Coins" },
  { slug: "gold_etf", label: "Gold ETF", icon: "BarChart3" },
  { slug: "silver_etf", label: "Silver ETF", icon: "LineChart" },
  { slug: "bonds", label: "Bonds", icon: "FileText" },
  { slug: "rbi_floating_bonds", label: "RBI Floating Bonds", icon: "Landmark" },
  { slug: "government_securities", label: "Government Securities", icon: "Building2" },
  { slug: "treasury_bills", label: "Treasury Bills", icon: "Receipt" },
  { slug: "corporate_bonds", label: "Corporate Bonds", icon: "Briefcase" },
  { slug: "reit", label: "REIT", icon: "Home" },
  { slug: "invit", label: "InvIT", icon: "Network" }
];
const INVESTMENT_CATEGORY_SLUGS = INVESTMENT_CATEGORIES.map((c) => c.slug);
const RISK_LEVELS = [
  { slug: "low", label: "Low" },
  { slug: "low_to_moderate", label: "Low to Moderate" },
  { slug: "moderate", label: "Moderate" },
  { slug: "moderately_high", label: "Moderately High" },
  { slug: "high", label: "High" }
];
const COMPARISON_ATTRIBUTES = [
  { key: "returns1y", label: "1Y Returns", field: "returns1y" },
  { key: "returns3y", label: "3Y Returns", field: "returns3y" },
  { key: "riskLevel", label: "Risk", field: "riskLevel" },
  { key: "minInvestmentAmount", label: "Min Investment", field: "minInvestmentAmount" },
  { key: "expenseRatio", label: "Expense Ratio", field: "expenseRatio" },
  { key: "taxBenefitsText", label: "Tax Benefits", field: "taxBenefitsText" }
];
function getInvestmentMarketplaceTaxonomy() {
  return {
    categories: INVESTMENT_CATEGORIES,
    riskLevels: RISK_LEVELS,
    comparisonAttributes: COMPARISON_ATTRIBUTES
  };
}
function normalizeCategoryList(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const allowed = new Set(INVESTMENT_CATEGORY_SLUGS);
  return [...new Set(raw.map((s) => String(s).trim()).filter((s) => allowed.has(s)))];
}
function getCategoryLabel(slug) {
  return INVESTMENT_CATEGORIES.find((c) => c.slug === slug)?.label || slug;
}
function getRiskLabel(slug) {
  return RISK_LEVELS.find((r) => r.slug === slug)?.label || slug;
}
export {
  COMPARISON_ATTRIBUTES,
  INVESTMENT_CATEGORIES,
  INVESTMENT_CATEGORY_SLUGS,
  RISK_LEVELS,
  getCategoryLabel,
  getInvestmentMarketplaceTaxonomy,
  getRiskLabel,
  normalizeCategoryList
};
