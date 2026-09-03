import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  normalizeRewardRules,
  rankCredLaxmiCards,
  scoreCredLaxmiCard,
} from '../../src/lib/credLaxmiCalculator.js';

describe('CredLaxmi calculator', () => {
  it('ranks the higher grocery earn-rate card first', () => {
    const result = rankCredLaxmiCards(
      [
        {
          id: 'low',
          name: 'Low Grocery Card',
          annualFee: 0,
          rewardRules: {
            reward_currency: { redemption_value_inr: 1 },
            earn_rates: [
              { category_code: 'GROCERIES', points_earned: 1, spend_unit_inr: 100 },
              { category_code: 'MISC_BASE', points_earned: 1, spend_unit_inr: 100 },
            ],
          },
        },
        {
          id: 'high',
          name: 'High Grocery Card',
          annualFee: 0,
          rewardRules: {
            reward_currency: { redemption_value_inr: 1 },
            earn_rates: [
              { category_code: 'GROCERIES', points_earned: 5, spend_unit_inr: 100 },
              { category_code: 'MISC_BASE', points_earned: 1, spend_unit_inr: 100 },
            ],
          },
        },
      ],
      [{ categoryCode: 'GROCERIES', amount: 20000, period: 'monthly' }],
    );
    assert.equal(result.winnerId, 'high');
    assert.equal(result.badgeLabel, 'Highest Savings');
    assert.equal(result.ctaLabel, 'Apply – Highest Savings');
    assert.ok(result.savingsAmount > 0);
    assert.ok(result.projectedAnnualSavings > 0);
    assert.equal(result.usedDefaultRules, false);
    assert.equal(result.defaultRulesDisclaimer, null);
  });

  it('waives annual fee when spend meets the threshold', () => {
    const card = {
      id: 'fee',
      name: 'Fee Card',
      annualFee: 1000,
      rewardRules: {
        fees: { annual_fee_waiver_spend_threshold: 100000 },
        reward_currency: { redemption_value_inr: 1 },
        earn_rates: [{ category_code: 'MISC_BASE', points_earned: 1, spend_unit_inr: 100 }],
      },
    };
    const waived = scoreCredLaxmiCard(card, [
      { categoryCode: 'MISC_BASE', amount: 10000, period: 'monthly' },
    ]);
    assert.equal(waived.feeWaived, true);
    assert.equal(waived.effectiveAnnualFee, 0);

    const charged = scoreCredLaxmiCard(card, [
      { categoryCode: 'MISC_BASE', amount: 5000, period: 'monthly' },
    ]);
    assert.equal(charged.feeWaived, false);
    assert.equal(charged.effectiveAnnualFee, 1000);
  });

  it('scores rent, taxes and wallet loads as zero-reward', () => {
    const scored = scoreCredLaxmiCard(
      {
        id: 'any',
        name: 'Any Card',
        annualFee: 0,
        rewardRules: {
          reward_currency: { redemption_value_inr: 1 },
          earn_rates: [{ category_code: 'MISC_BASE', points_earned: 5, spend_unit_inr: 100 }],
        },
      },
      [
        { categoryCode: 'RENT', amount: 40000, period: 'monthly' },
        { categoryCode: 'GOVT_TAXES', amount: 10000, period: 'monthly' },
        { categoryCode: 'WALLET_LOAD', amount: 5000, period: 'monthly' },
      ],
    );
    assert.equal(scored.pointsEarningsInr, 0);
    assert.ok(scored.categoryBreakdown.every((row) => row.earningsInr === 0));
  });

  it('applies a conservative 1% default when reward rules are missing', () => {
    const rules = normalizeRewardRules({ id: 'plain', name: 'Plain', annualFee: 500 });
    assert.equal(rules.usedDefaultRules, true);
    assert.equal(rules.rewardCurrency.redemptionValueInr, 1);

    const result = rankCredLaxmiCards(
      [
        { id: 'a', name: 'Plain A', annualFee: 500 },
        { id: 'b', name: 'Plain B', annualFee: 0 },
      ],
      [{ categoryCode: 'GROCERIES', amount: 10000, period: 'monthly' }],
    );
    assert.equal(result.winnerId, 'b');
    assert.equal(result.usedDefaultRules, true);
    assert.match(result.defaultRulesDisclaimer, /1%/);
  });

  it('falls overflow above monthly points cap back to MISC_BASE', () => {
    const scored = scoreCredLaxmiCard(
      {
        id: 'capped',
        name: 'Capped Shopping',
        annualFee: 0,
        rewardRules: {
          reward_currency: { redemption_value_inr: 1 },
          earn_rates: [
            {
              category_code: 'ONLINE_SHOPPING',
              points_earned: 10,
              spend_unit_inr: 100,
              monthly_points_cap: 1000,
            },
            { category_code: 'MISC_BASE', points_earned: 1, spend_unit_inr: 100 },
          ],
        },
      },
      [{ categoryCode: 'ONLINE_SHOPPING', amount: 50000, period: 'monthly' }],
    );
    // Cap: 1000 pts/month × ₹1 × 12 = 12,000. Overflow spend ₹40,000 at 1% = 4,800.
    assert.equal(scored.howYouSave.cappedOverflowInr, 4800);
    assert.equal(scored.pointsEarningsInr, 16800);
  });
});
