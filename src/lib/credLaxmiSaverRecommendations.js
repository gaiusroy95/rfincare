import { round2, toNum } from './financialCalculators/math.js';
import { getCredLaxmiCategory } from './credLaxmiCategories.js';
import { rankCredLaxmiCards, scoreCredLaxmiCard } from './credLaxmiCalculator.js';

/** Admin-manageable recommendation label catalog (codes stable for engine). */
export const CREDLAXMI_RECOMMENDATION_LABELS = [
  {
    code: 'HOME_SPENDING',
    label: 'Home Spending Saver',
    categoryCodes: ['GROCERIES', 'UTILITIES_BILLS'],
  },
  {
    code: 'GROCERY',
    label: 'Grocery Saver',
    categoryCodes: ['GROCERIES'],
  },
  {
    code: 'BUSINESS',
    label: 'Business Spending Saver',
    categoryCodes: [
      'VENDOR_PAYMENTS',
      'OFFICE_SUPPLIES',
      'ADVERTISING_SOFTWARE',
      'CLIENT_ENTERTAINMENT',
      'TRAVEL_LODGING',
    ],
  },
  {
    code: 'TRAVEL',
    label: 'Travel Saver',
    categoryCodes: ['TRAVEL_FLIGHTS', 'TRAVEL_LODGING'],
  },
  {
    code: 'ONLINE_SHOPPER',
    label: 'Online Shopper Saver',
    categoryCodes: ['ONLINE_SHOPPING'],
  },
  {
    code: 'FOOD_DINING',
    label: 'Food & Dining Saver',
    categoryCodes: ['DINING_FOOD'],
  },
  {
    code: 'FUEL',
    label: 'Fuel Saver',
    categoryCodes: ['FUEL'],
  },
  {
    code: 'BILLS_UTILITIES',
    label: 'Bills & Utilities Saver',
    categoryCodes: ['UTILITIES_BILLS'],
  },
  {
    code: 'ALL_ROUNDER',
    label: 'All-Rounder Savings Card',
    categoryCodes: [],
  },
];

function annualize(amount, period) {
  const n = toNum(amount, 0);
  const p = String(period || 'monthly').toLowerCase();
  if (p === 'annual' || p === 'yearly') return n;
  if (p === 'quarterly' || p === 'quarter') return n * 4;
  return n * 12;
}

function monthlyFromAnnual(annual) {
  return round2(toNum(annual, 0) / 12);
}

function formatInr(n) {
  return `₹${Math.round(toNum(n, 0)).toLocaleString('en-IN')}`;
}

/**
 * Analyze customer spend pattern from entered category amounts.
 */
export function analyzeCredLaxmiSpendProfile(spendProfile = [], spendPeriod = 'monthly') {
  const rows = (spendProfile || [])
    .map((s) => {
      const categoryCode = String(s.category_code || s.categoryCode || '').toUpperCase();
      const meta = getCredLaxmiCategory(categoryCode);
      const annualSpend = annualize(s.amount ?? s.spend, s.period || s.frequency || spendPeriod);
      return {
        categoryCode,
        label: meta?.label || categoryCode,
        expenseType: meta?.expenseType || 'SPECIAL',
        isRewardEligible: meta?.isRewardEligible !== false,
        annualSpend,
        monthlySpend: monthlyFromAnnual(annualSpend),
      };
    })
    .filter((r) => r.categoryCode && r.annualSpend > 0);

  const totalAnnualSpend = round2(rows.reduce((sum, r) => sum + r.annualSpend, 0));
  const totalMonthlySpend = monthlyFromAnnual(totalAnnualSpend);

  const byCategory = rows
    .map((r) => ({
      ...r,
      percent: totalAnnualSpend > 0 ? round2((r.annualSpend / totalAnnualSpend) * 100) : 0,
    }))
    .sort((a, b) => b.annualSpend - a.annualSpend);

  const householdAnnual = round2(
    rows.filter((r) => r.expenseType === 'HOUSEHOLD').reduce((s, r) => s + r.annualSpend, 0),
  );
  const businessAnnual = round2(
    rows.filter((r) => r.expenseType === 'BUSINESS').reduce((s, r) => s + r.annualSpend, 0),
  );
  const specialAnnual = round2(
    rows.filter((r) => r.expenseType === 'SPECIAL').reduce((s, r) => s + r.annualSpend, 0),
  );

  const rewardRows = byCategory.filter((r) => r.isRewardEligible);
  const primary = rewardRows[0] || byCategory[0] || null;
  const secondary = rewardRows[1] || byCategory[1] || null;

  return {
    spendPeriod,
    totalMonthlySpend,
    totalAnnualSpend,
    householdAnnual,
    businessAnnual,
    specialAnnual,
    householdPercent: totalAnnualSpend > 0 ? round2((householdAnnual / totalAnnualSpend) * 100) : 0,
    businessPercent: totalAnnualSpend > 0 ? round2((businessAnnual / totalAnnualSpend) * 100) : 0,
    categoryBreakdown: byCategory,
    primaryCategory: primary,
    secondaryCategory: secondary,
    dominantBehaviour: resolveDominantBehaviour({
      byCategory,
      householdAnnual,
      businessAnnual,
      totalAnnualSpend,
    }),
  };
}

function resolveDominantBehaviour({ byCategory, householdAnnual, businessAnnual, totalAnnualSpend }) {
  if (!totalAnnualSpend) return { code: 'ALL_ROUNDER', label: 'All-Rounder Savings Card' };

  if (businessAnnual / totalAnnualSpend >= 0.35) {
    return { code: 'BUSINESS', label: 'Business Spending Saver' };
  }

  const top = byCategory.find((c) => c.isRewardEligible) || byCategory[0];
  if (!top) return { code: 'ALL_ROUNDER', label: 'All-Rounder Savings Card' };

  const map = {
    GROCERIES: { code: 'GROCERY', label: 'Grocery Saver' },
    DINING_FOOD: { code: 'FOOD_DINING', label: 'Food & Dining Saver' },
    UTILITIES_BILLS: { code: 'BILLS_UTILITIES', label: 'Bills & Utilities Saver' },
    FUEL: { code: 'FUEL', label: 'Fuel Saver' },
    TRAVEL_FLIGHTS: { code: 'TRAVEL', label: 'Travel Saver' },
    TRAVEL_LODGING: { code: 'TRAVEL', label: 'Travel Saver' },
    ONLINE_SHOPPING: { code: 'ONLINE_SHOPPER', label: 'Online Shopper Saver' },
    VENDOR_PAYMENTS: { code: 'BUSINESS', label: 'Business Spending Saver' },
    OFFICE_SUPPLIES: { code: 'BUSINESS', label: 'Business Spending Saver' },
    ADVERTISING_SOFTWARE: { code: 'BUSINESS', label: 'Business Spending Saver' },
    CLIENT_ENTERTAINMENT: { code: 'BUSINESS', label: 'Business Spending Saver' },
  };

  if (['GROCERIES', 'UTILITIES_BILLS'].includes(top.categoryCode) && householdAnnual / totalAnnualSpend >= 0.4) {
    return { code: 'HOME_SPENDING', label: 'Home Spending Saver' };
  }

  return map[top.categoryCode] || { code: 'ALL_ROUNDER', label: 'All-Rounder Savings Card' };
}

function labelForCategories(categoryCodes = []) {
  const codes = categoryCodes.map((c) => String(c).toUpperCase());
  for (const entry of CREDLAXMI_RECOMMENDATION_LABELS) {
    if (!entry.categoryCodes.length) continue;
    if (codes.some((c) => entry.categoryCodes.includes(c))) {
      // Prefer exact single-category match first
      if (codes.length === 1 && entry.categoryCodes.length === 1 && entry.categoryCodes[0] === codes[0]) {
        return entry;
      }
    }
  }
  for (const entry of CREDLAXMI_RECOMMENDATION_LABELS) {
    if (entry.categoryCodes.length && codes.some((c) => entry.categoryCodes.includes(c))) {
      return entry;
    }
  }
  return CREDLAXMI_RECOMMENDATION_LABELS.find((l) => l.code === 'ALL_ROUNDER');
}

function categoryEarnings(scoredCard, categoryCodes = []) {
  const set = new Set(categoryCodes.map((c) => String(c).toUpperCase()));
  if (!set.size) return toNum(scoredCard?.netAnnualValue, 0);
  return round2(
    (scoredCard?.categoryBreakdown || [])
      .filter((c) => set.has(String(c.categoryCode || '').toUpperCase()))
      .reduce((sum, c) => sum + toNum(c.earningsInr, 0), 0),
  );
}

function pickBestCard(ranking, { categoryCodes = [], excludeIds = new Set() } = {}) {
  let best = null;
  let bestScore = -Infinity;
  for (const row of ranking || []) {
    const id = String(row.cardId || '');
    if (excludeIds.has(id)) continue;
    const score = categoryCodes.length
      ? categoryEarnings(row, categoryCodes)
      : toNum(row.netAnnualValue, 0);
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  return best;
}

function buildWhyText({ slot, profile, card, label }) {
  const primary = profile.primaryCategory;
  const secondary = profile.secondaryCategory;
  const monthly = primary ? formatInr(primary.monthlySpend) : null;

  if (slot === 'all_rounder') {
    return {
      title: `Recommended for You: ${label}`,
      body:
        `This card delivers the strongest projected net annual savings (${formatInr(card.netAnnualValue)}/year) `
        + 'across multiple spending categories based on your entered profile.',
    };
  }

  if (slot === 'business') {
    return {
      title: `Recommended for You: ${label}`,
      body:
        `A significant portion of your spending (${profile.businessPercent}%) is business/corporate. `
        + 'This card is optimized for vendor, software, travel & lodging and related business rewards.',
    };
  }

  if (slot === 'secondary' && secondary) {
    return {
      title: `Recommended for You: ${label}`,
      body:
        `Your second-highest spend is ${secondary.label} (about ${formatInr(secondary.monthlySpend)}/month). `
        + 'This card is stronger for that category while remaining distinct from your primary saver.',
    };
  }

  if (slot === 'lifestyle') {
    return {
      title: `Recommended for You: ${label}`,
      body:
        'Based on your overall lifestyle mix (travel, shopping, food, fuel, etc.), '
        + 'this card aligns rewards with how you actually spend day to day.',
    };
  }

  // primary
  if (primary) {
    return {
      title: `Recommended for You: ${label}`,
      body:
        `You spend approximately ${monthly}/month on ${primary.label}`
        + (profile.householdPercent >= 35 ? ' and related household purchases' : '')
        + `. This card provides higher rewards across your major ${label.replace(/ Saver$/i, '').toLowerCase()} categories.`,
    };
  }

  return {
    title: `Recommended for You: ${label}`,
    body: 'This card matches your entered spending pattern for projected annual savings.',
  };
}

function enrichCardPresentation(scored, fullCard, { slot, profile, labelMeta }) {
  const label = labelMeta?.label || 'Recommended Card';
  const why = buildWhyText({ slot, profile, card: scored, label });
  const benefits = [];
  if (Array.isArray(fullCard?.keyBenefits)) benefits.push(...fullCard.keyBenefits.filter(Boolean));
  if (Array.isArray(fullCard?.benefits)) benefits.push(...fullCard.benefits.filter(Boolean));
  if (scored.topCategories?.length) {
    benefits.push(`Strong on: ${scored.topCategories.slice(0, 3).join(', ')}`);
  }
  if (fullCard?.loungeAccess || scored.loungeValueInr > 0) {
    benefits.push('Lounge / travel benefit value included in estimate');
  }

  return {
    rank: 0,
    recommendationSlot: slot,
    recommendationCode: labelMeta?.code || 'ALL_ROUNDER',
    recommendationLabel: label,
    cardId: scored.cardId,
    name: scored.name || fullCard?.name,
    bankName: scored.bankName || fullCard?.bankName,
    cardType: (fullCard?.categories || [])[0] || fullCard?.cardType || 'Credit Card',
    categories: fullCard?.categories || [],
    logoUrl: fullCard?.logoUrl || fullCard?.logo_url || null,
    joiningFee: fullCard?.joiningFee ?? fullCard?.joining_fee ?? null,
    annualFee: scored.annualFee,
    effectiveAnnualFee: scored.effectiveAnnualFee,
    feeWaived: scored.feeWaived,
    estimatedAnnualRewards: scored.totalAnnualEarnings,
    estimatedAnnualSaving: scored.netAnnualValue,
    estimatedAnnualSpend: scored.totalAnnualSpend,
    keyBenefits: [...new Set(benefits)].slice(0, 6),
    whyRecommended: why,
    howYouSave: scored.howYouSave,
    applyUrl: fullCard?.applyUrl || fullCard?.apply_url || null,
    hasStructuredRules: scored.hasStructuredRules,
  };
}

/**
 * Build diversified Top-5 recommendations from full ranking + spend profile.
 */
export function buildCredLaxmiTop5Recommendations({
  cards = [],
  spendProfile = [],
  spendPeriod = 'monthly',
} = {}) {
  const profile = analyzeCredLaxmiSpendProfile(spendProfile, spendPeriod);
  const ranked = rankCredLaxmiCards(cards, spendProfile);
  const ranking = ranked.ranking || [];
  const byId = new Map((cards || []).map((c) => [String(c.id || c.cardId), c]));

  const used = new Set();
  const picks = [];

  const pushPick = (scored, slot, labelMeta) => {
    if (!scored) return;
    const id = String(scored.cardId || '');
    if (!id || used.has(id)) return;
    used.add(id);
    picks.push(
      enrichCardPresentation(scored, byId.get(id) || {}, {
        slot,
        profile,
        labelMeta,
      }),
    );
  };

  // 1) Primary category saver
  const primaryCodes = profile.primaryCategory
    ? [profile.primaryCategory.categoryCode]
    : [];
  const primaryLabel = primaryCodes.length
    ? labelForCategories(primaryCodes)
    : profile.dominantBehaviour;
  pushPick(
    pickBestCard(ranking, { categoryCodes: primaryCodes, excludeIds: used }),
    'primary',
    primaryLabel,
  );

  // 2) Secondary category saver
  const secondaryCodes = profile.secondaryCategory
    ? [profile.secondaryCategory.categoryCode]
    : [];
  if (secondaryCodes.length) {
    pushPick(
      pickBestCard(ranking, { categoryCodes: secondaryCodes, excludeIds: used }),
      'secondary',
      labelForCategories(secondaryCodes),
    );
  }

  // 3) Lifestyle / usage saver (travel / shopping / food / fuel cluster)
  const lifestyleCodes = ['TRAVEL_FLIGHTS', 'ONLINE_SHOPPING', 'DINING_FOOD', 'FUEL', 'TRAVEL_LODGING'];
  const lifestyleSpend = profile.categoryBreakdown
    .filter((c) => lifestyleCodes.includes(c.categoryCode))
    .sort((a, b) => b.annualSpend - a.annualSpend)[0];
  if (lifestyleSpend) {
    pushPick(
      pickBestCard(ranking, {
        categoryCodes: [lifestyleSpend.categoryCode],
        excludeIds: used,
      }),
      'lifestyle',
      labelForCategories([lifestyleSpend.categoryCode]),
    );
  }

  // 4) Business / corporate saver when business spend is material (>=15%)
  if (profile.businessPercent >= 15) {
    const businessCodes = CREDLAXMI_RECOMMENDATION_LABELS.find((l) => l.code === 'BUSINESS')
      ?.categoryCodes || [];
    pushPick(
      pickBestCard(ranking, { categoryCodes: businessCodes, excludeIds: used }),
      'business',
      labelForCategories(businessCodes),
    );
  }

  // 5) All-rounder / maximum savings (highest NAV not already used)
  pushPick(
    pickBestCard(ranking, { categoryCodes: [], excludeIds: used }),
    'all_rounder',
    CREDLAXMI_RECOMMENDATION_LABELS.find((l) => l.code === 'ALL_ROUNDER'),
  );

  // Fill remaining slots up to 5 with next-best unique cards
  for (const row of ranking) {
    if (picks.length >= 5) break;
    pushPick(row, 'all_rounder', CREDLAXMI_RECOMMENDATION_LABELS.find((l) => l.code === 'ALL_ROUNDER'));
  }

  const recommendations = picks.slice(0, 5).map((row, idx) => ({ ...row, rank: idx + 1 }));

  // Re-score all-rounder presentation to ensure NAV uses full profile (already does)
  const maxSaving = recommendations.reduce(
    (m, r) => Math.max(m, toNum(r.estimatedAnnualSaving, 0)),
    0,
  );

  return {
    profile,
    recommendations,
    rankingSummary: {
      cardsScored: ranking.length,
      maxEstimatedAnnualSaving: maxSaving,
      winnerId: ranked.winnerId,
    },
    recommendationLabels: CREDLAXMI_RECOMMENDATION_LABELS,
    disclaimer: ranked.disclaimer,
    defaultRulesDisclaimer: ranked.defaultRulesDisclaimer,
  };
}

/** Convenience: score a single card under profile (exported for tests). */
export function scoreCardUnderProfile(card, spendProfile) {
  return scoreCredLaxmiCard(card, spendProfile);
}
