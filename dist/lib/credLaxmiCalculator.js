import { round2, toNum } from "./financialCalculators/math.js";
import { CREDLAXMI_CATEGORY_CODES, getCredLaxmiCategory } from "./credLaxmiCategories.js";
const BASE_CATEGORY = "MISC_BASE";
function parseRules(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw;
  return null;
}
function normalizeRewardRules(card = {}) {
  const fromCard = parseRules(card.rewardRules ?? card.reward_rules);
  const annualFee = toNum(
    fromCard?.fees?.annual_fee ?? card.annualFee ?? card.annual_fee,
    0
  );
  const joiningFee = toNum(
    fromCard?.fees?.joining_fee ?? card.joiningFee ?? card.joining_fee,
    0
  );
  const waiver = toNum(
    fromCard?.fees?.annual_fee_waiver_spend_threshold ?? card.annualFeeWaiverSpendThreshold ?? card.annual_fee_waiver_spend_threshold,
    NaN
  );
  const redemption = toNum(
    fromCard?.reward_currency?.redemption_value_inr ?? fromCard?.redemptionValueInr ?? fromCard?.redemption_value_inr,
    NaN
  );
  let earnRates = Array.isArray(fromCard?.earn_rates) ? fromCard.earn_rates : Array.isArray(fromCard?.earnRates) ? fromCard.earnRates : [];
  earnRates = earnRates.map((r) => ({
    categoryCode: String(r.category_code || r.categoryCode || "").toUpperCase(),
    pointsEarned: toNum(r.points_earned ?? r.pointsEarned, 0),
    spendUnitInr: toNum(r.spend_unit_inr ?? r.spendUnitInr, 100),
    monthlyPointsCap: toNum(r.monthly_points_cap ?? r.monthlyPointsCap, NaN),
    expenseType: r.expense_type || r.expenseType || null
  })).filter((r) => r.categoryCode && CREDLAXMI_CATEGORY_CODES.has(r.categoryCode) && r.pointsEarned > 0);
  const usedDefaultRules = !earnRates.length;
  if (usedDefaultRules) {
    earnRates = [
      {
        categoryCode: BASE_CATEGORY,
        pointsEarned: 1,
        spendUnitInr: 100,
        monthlyPointsCap: NaN,
        expenseType: "SPECIAL"
      }
    ];
  }
  const welcome = Array.isArray(fromCard?.welcome_benefits) ? fromCard.welcome_benefits : Array.isArray(fromCard?.welcomeBenefits) ? fromCard.welcomeBenefits : [];
  const welcomeInr = welcome.reduce(
    (sum, w) => sum + toNum(w.value_inr ?? w.valueInr ?? w.amount, 0),
    0
  ) || toNum(fromCard?.welcomeBenefitInr, 0);
  const milestones = Array.isArray(fromCard?.milestone_benefits) ? fromCard.milestone_benefits : Array.isArray(fromCard?.milestoneBenefits) ? fromCard.milestoneBenefits : [];
  const loungeVisits = toNum(
    fromCard?.additional_benefits?.lounge_visits_per_year ?? fromCard?.loungeVisitsPerYear ?? (card.loungeAccess || card.lounge_access ? 2 : 0),
    0
  );
  const loungeValue = toNum(
    fromCard?.additional_benefits?.lounge_visit_value_inr ?? fromCard?.loungeVisitValueInr ?? (loungeVisits > 0 ? 1500 : 0),
    0
  );
  return {
    usedDefaultRules,
    fees: {
      annualFee,
      joiningFee,
      annualFeeWaiverSpendThreshold: Number.isFinite(waiver) ? waiver : null
    },
    rewardCurrency: {
      type: fromCard?.reward_currency?.type || fromCard?.rewardCurrencyType || "points",
      redemptionValueInr: Number.isFinite(redemption) ? redemption : usedDefaultRules ? 1 : 0.25
    },
    earnRates,
    welcomeBenefitInr: welcomeInr,
    milestones: milestones.map((m) => ({
      spendThreshold: toNum(m.spend_threshold ?? m.spendThreshold ?? m.threshold, 0),
      bonusInr: toNum(m.bonus_inr ?? m.bonusInr ?? m.value_inr ?? m.valueInr, 0),
      frequency: String(m.frequency || "annual").toLowerCase()
    })),
    lounge: {
      visitsPerYear: loungeVisits,
      visitValueInr: loungeValue
    }
  };
}
function annualizeSpend(amount, period) {
  const n = toNum(amount, 0);
  const p = String(period || "monthly").toLowerCase();
  return p === "annual" || p === "yearly" ? n : n * 12;
}
function findRate(rules, categoryCode) {
  const code = String(categoryCode || "").toUpperCase();
  return rules.earnRates.find((r) => r.categoryCode === code) || rules.earnRates.find((r) => r.categoryCode === BASE_CATEGORY) || null;
}
function scoreCredLaxmiCard(card, spendProfile = []) {
  const rules = normalizeRewardRules(card);
  const redemption = rules.rewardCurrency.redemptionValueInr;
  const spends = (spendProfile || []).map((s) => ({
    categoryCode: String(s.category_code || s.categoryCode || "").toUpperCase(),
    annualSpend: annualizeSpend(s.amount ?? s.spend, s.period || s.frequency)
  })).filter((s) => s.categoryCode && s.annualSpend > 0);
  const totalAnnualSpend = round2(spends.reduce((sum, s) => sum + s.annualSpend, 0));
  const categoryBreakdown = [];
  let pointsEarningsInr = 0;
  let cappedOverflowInr = 0;
  for (const spend of spends) {
    const meta = getCredLaxmiCategory(spend.categoryCode);
    if (meta && meta.isRewardEligible === false) {
      categoryBreakdown.push({
        categoryCode: spend.categoryCode,
        label: meta.label,
        annualSpend: spend.annualSpend,
        earningsInr: 0,
        note: "Category typically not reward-eligible"
      });
      continue;
    }
    const rate = findRate(rules, spend.categoryCode);
    if (!rate || rate.spendUnitInr <= 0) {
      categoryBreakdown.push({
        categoryCode: spend.categoryCode,
        label: meta?.label || spend.categoryCode,
        annualSpend: spend.annualSpend,
        earningsInr: 0,
        note: "No earn rate"
      });
      continue;
    }
    const monthlySpend = spend.annualSpend / 12;
    const rawMonthlyPoints = monthlySpend / rate.spendUnitInr * rate.pointsEarned;
    let creditedMonthlyPoints = rawMonthlyPoints;
    let overflowMonthlyPoints = 0;
    if (Number.isFinite(rate.monthlyPointsCap) && rate.monthlyPointsCap >= 0) {
      creditedMonthlyPoints = Math.min(rawMonthlyPoints, rate.monthlyPointsCap);
      overflowMonthlyPoints = Math.max(0, rawMonthlyPoints - rate.monthlyPointsCap);
    }
    const baseRate = rules.earnRates.find((r) => r.categoryCode === BASE_CATEGORY);
    let overflowInr = 0;
    if (overflowMonthlyPoints > 0 && baseRate && baseRate.spendUnitInr > 0 && rate.pointsEarned > 0) {
      const overflowMonthlySpend = overflowMonthlyPoints / rate.pointsEarned * rate.spendUnitInr;
      const overflowMonthlyBasePoints = overflowMonthlySpend / baseRate.spendUnitInr * baseRate.pointsEarned;
      overflowInr = round2(overflowMonthlyBasePoints * redemption * 12);
      cappedOverflowInr = round2(cappedOverflowInr + overflowInr);
    }
    const earningsInr = round2(creditedMonthlyPoints * redemption * 12 + overflowInr);
    pointsEarningsInr = round2(pointsEarningsInr + earningsInr);
    categoryBreakdown.push({
      categoryCode: spend.categoryCode,
      label: meta?.label || spend.categoryCode,
      annualSpend: spend.annualSpend,
      earningsInr,
      pointsEarned: round2(creditedMonthlyPoints * 12),
      rateLabel: `${rate.pointsEarned} pts / ₹${rate.spendUnitInr}`
    });
  }
  let milestoneBonusInr = 0;
  for (const m of rules.milestones) {
    if (m.spendThreshold <= 0 || m.bonusInr <= 0) continue;
    if (totalAnnualSpend >= m.spendThreshold) {
      const freq = m.frequency === "monthly" ? 12 : 1;
      milestoneBonusInr = round2(milestoneBonusInr + m.bonusInr * freq);
    }
  }
  const welcomeBenefitInr = round2(rules.welcomeBenefitInr);
  const loungeValueInr = round2(rules.lounge.visitsPerYear * rules.lounge.visitValueInr);
  const totalAnnualEarnings = round2(
    pointsEarningsInr + milestoneBonusInr + welcomeBenefitInr + loungeValueInr
  );
  let effectiveAnnualFee = rules.fees.annualFee;
  let feeWaived = false;
  const waiverThreshold = rules.fees.annualFeeWaiverSpendThreshold;
  if (waiverThreshold != null && Number.isFinite(waiverThreshold) && totalAnnualSpend >= waiverThreshold) {
    effectiveAnnualFee = 0;
    feeWaived = true;
  }
  const netAnnualValue = round2(totalAnnualEarnings - effectiveAnnualFee);
  const topCategories = [...categoryBreakdown].filter((c) => c.earningsInr > 0).sort((a, b) => b.earningsInr - a.earningsInr).slice(0, 3).map((c) => c.label);
  return {
    cardId: card.id || card.cardId,
    name: card.name || card.productName,
    bankName: card.bankName || card.bank_name || card.provider,
    hasStructuredRules: !rules.usedDefaultRules,
    usedDefaultRules: rules.usedDefaultRules,
    totalAnnualSpend,
    totalAnnualEarnings,
    pointsEarningsInr,
    milestoneBonusInr,
    welcomeBenefitInr,
    loungeValueInr,
    annualFee: rules.fees.annualFee,
    effectiveAnnualFee,
    feeWaived,
    netAnnualValue,
    categoryBreakdown,
    topCategories,
    howYouSave: {
      baseRewards: pointsEarningsInr,
      milestones: milestoneBonusInr,
      welcome: welcomeBenefitInr,
      lounge: loungeValueInr,
      feeCharged: effectiveAnnualFee,
      feeWaived,
      cappedOverflowInr
    }
  };
}
function rankCredLaxmiCards(cards, spendProfile) {
  const scored = (cards || []).map((c) => scoreCredLaxmiCard(c, spendProfile));
  scored.sort((a, b) => b.netAnnualValue - a.netAnnualValue);
  const winner = scored[0] || null;
  const runnerUp = scored[1] || null;
  let savingsAmount = 0;
  let savingsInsight = "";
  if (winner && runnerUp) {
    savingsAmount = round2(winner.netAnnualValue - runnerUp.netAnnualValue);
    if (savingsAmount > 0) {
      savingsInsight = `${winner.name || "This card"} delivers about ₹${savingsAmount.toLocaleString("en-IN")} more net annual value than ${runnerUp.name || "the next option"} based on your spending profile.`;
    } else {
      savingsInsight = `${winner.name || "This card"} is the best fit for your spending profile.`;
    }
  } else if (winner) {
    savingsInsight = `${winner.name || "This card"} is your best available match for the entered spends.`;
  }
  const projectedAnnualSavings = winner ? Math.max(0, winner.netAnnualValue) : 0;
  const usedDefaultRules = scored.some((row) => row.usedDefaultRules);
  return {
    winnerId: winner?.cardId || null,
    winner,
    ranking: scored,
    savingsAmount,
    savingsInsight,
    projectedAnnualSavings,
    badgeLabel: savingsAmount > 0 ? "Highest Savings" : "Best Value",
    ctaLabel: savingsAmount > 0 ? "Apply – Highest Savings" : "Apply – Best Value",
    usedDefaultRules,
    defaultRulesDisclaimer: usedDefaultRules ? "One or more cards have no structured reward rules. A conservative 1% base cashback estimate was used. Actual issuer rewards may differ." : null,
    disclaimer: "Projected annual savings are estimates based on your spend inputs and card reward rules. Actual rewards may vary by issuer terms."
  };
}
export {
  normalizeRewardRules,
  rankCredLaxmiCards,
  scoreCredLaxmiCard
};
