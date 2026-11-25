import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getCalculatorBySlug,
  listCalculators,
  runCalculator,
} from '../../src/lib/financialCalculators/index.js';

// Inputs that legitimately do not move the result at the +10% probe (threshold / statutory cap).
const INSENSITIVE_BY_DESIGN = new Set(['capital-gain.holdingMonths', 'section-80d.selfPremium']);

describe('Financial calculators — every input reaches the engine', () => {
  it('each numeric input changes the result (string inputs, like the web form)', () => {
    const ignored = [];
    for (const { slug } of listCalculators()) {
      const defaults = getCalculatorBySlug(slug).defaults || {};
      const asForm = Object.fromEntries(
        Object.entries(defaults).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v]),
      );
      const base = JSON.stringify(runCalculator(slug, asForm).result);
      assert.doesNotMatch(base, /null|NaN/, `${slug} returned null/NaN`);
      for (const [key, value] of Object.entries(defaults)) {
        if (typeof value !== 'number' || value === 0) continue;
        if (INSENSITIVE_BY_DESIGN.has(`${slug}.${key}`)) continue;
        const bumped = { ...asForm, [key]: String(value * 1.1 + 1) };
        if (JSON.stringify(runCalculator(slug, bumped).result) === base) ignored.push(`${slug}.${key}`);
      }
    }
    assert.deepEqual(ignored, []);
  });

  it('Goal SIP, Annuity and Capital Gain return real values (client feedback 21-11-2026)', () => {
    const sip = runCalculator('goal-sip', { goalAmount: '5000000', years: '15', expectedReturn: '11' }).result;
    assert.equal(sip.tenureMonths, 180);
    assert.ok(sip.monthlySipRequired > 10000 && sip.monthlySipRequired < 12000);

    const annuity = runCalculator('annuity', { principal: '5000000', annualRate: '7', payoutYears: '20' }).result;
    assert.ok(annuity.monthlyPayout > 38000 && annuity.monthlyPayout < 39500);

    const gain = runCalculator('capital-gain', {
      purchasePrice: '100000',
      salePrice: '1800000',
      holdingMonths: '18',
      assetType: 'equity',
    }).result;
    assert.equal(gain.capitalGain, 1700000);
    assert.equal(gain.gainType, 'LTCG');
    assert.equal(gain.estimatedTax, 196875);
  });
});
