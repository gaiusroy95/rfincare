import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  outstandingPrincipal,
  rankSmartLoanProducts,
  scoreSmartLoanProduct,
} from '../../src/lib/smartLoanCalculator.js';

describe('SmartLoan calculator', () => {
  it('computes outstanding principal after paid months', () => {
    const outstanding = outstandingPrincipal(1000000, 12, 60, 30);
    assert.ok(outstanding > 0);
    assert.ok(outstanding < 1000000);
  });

  it('ranks lower-rate product ahead for low_roi priority', () => {
    const result = rankSmartLoanProducts(
      [
        {
          productId: 'a',
          name: 'High Rate Bank',
          interestRate: 14,
          processingFeePercentage: 2,
          foreclosureFeePct: 4,
          partPaymentFeePct: 2,
        },
        {
          productId: 'b',
          name: 'Low Rate Bank',
          interestRate: 10,
          processingFeePercentage: 1,
          foreclosureFeePct: 4,
          partPaymentFeePct: 2,
        },
      ],
      {
        loanAmount: 500000,
        tenureMonths: 60,
        priorities: ['low_roi', 'low_emi'],
      },
    );
    assert.equal(result.winnerId, 'b');
    assert.ok(result.savingsAmount >= 0);
    assert.ok(result.savingsInsight);
    assert.ok(['Highest Savings', 'Best Match for Your Needs'].includes(result.badgeLabel));
  });

  it('applies foreclosure simulation when low_foreclosure selected', () => {
    const scored = scoreSmartLoanProduct(
      {
        productId: 'x',
        name: 'Test',
        interestRate: 12,
        processingFeePercentage: 1,
        foreclosureFeePct: 5,
        foreclosureAllowedAfterMonths: 12,
      },
      {
        loanAmount: 1000000,
        tenureMonths: 60,
        priorities: ['low_foreclosure'],
      },
    );
    assert.ok(scored.scenarios.foreclosure);
    assert.equal(scored.scenarios.foreclosure.feePct, 5);
    assert.ok(scored.simulatedScoreCost > 0);
  });

  it('applies part-payment simulation when low_part_payment selected', () => {
    const scored = scoreSmartLoanProduct(
      {
        productId: 'y',
        name: 'Test',
        interestRate: 11,
        processingFeePercentage: 1,
        partPaymentFeePct: 2,
      },
      {
        loanAmount: 800000,
        tenureMonths: 48,
        priorities: ['low_part_payment'],
      },
    );
    assert.ok(scored.scenarios.partPayment);
    assert.equal(scored.scenarios.partPayment.lumpPercent, 20);
    assert.equal(scored.scenarios.partPayment.afterMonths, 12);
  });
});
