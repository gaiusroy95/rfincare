import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAgentCode } from '../../src/lib/agentAttribution.js';
import { calculateCommissionFromAmount } from '../../src/lib/agentCustomerProvision.js';
import { normalizeCommissionCsvRow } from '../../src/lib/agentCommission.js';

describe('agent attribution', () => {
  it('normalizes agent codes to uppercase', () => {
    assert.equal(normalizeAgentCode('rfa20261'), 'RFA20261');
    assert.equal(normalizeAgentCode(''), null);
    assert.equal(normalizeAgentCode(null), null);
  });
});

describe('commission calculation', () => {
  it('computes percentage commission', () => {
    assert.equal(
      calculateCommissionFromAmount({ amount: 100000, config: { commission_type: 'percentage', commission_value: 2.5 } }),
      2500,
    );
  });

  it('computes fixed commission', () => {
    assert.equal(
      calculateCommissionFromAmount({ amount: 50000, config: { commission_type: 'fixed', commission_value: 500 } }),
      500,
    );
  });
});

describe('commission CSV product types', () => {
  it('accepts insurance and SIP product types', () => {
    const insurance = normalizeCommissionCsvRow({
      agent_code: 'RFA20261',
      loan_type: 'insurance',
      commission_value: '1.5',
    });
    assert.equal(insurance.loanType, 'insurance');

    const sip = normalizeCommissionCsvRow({
      agent_code: 'RFA20261',
      loan_type: 'mutual_fund_sip',
      commission_value: '2',
    });
    assert.equal(sip.loanType, 'mutual_fund_sip');
  });
});
