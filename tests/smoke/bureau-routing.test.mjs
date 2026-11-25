import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_BUREAU_ROUTING,
  applicationProductKey,
  normalizeProductKey,
} from '../../src/lib/cibilBureauRouting.js';
import { buildSurepassCibilBody, getSurepassConfig } from '../../src/lib/surepassCibil.js';

describe('Credit bureau routing (Experian default, Business Loan → CRIF)', () => {
  it('defaults to Experian with Business Loan routed to CRIF High Mark', () => {
    assert.equal(DEFAULT_BUREAU_ROUTING.defaultBureau, 'experian');
    assert.equal(DEFAULT_BUREAU_ROUTING.byProduct.business_loan, 'crif_high_mark');
  });

  it('normalizes product names from forms, applications and the CMS', () => {
    assert.equal(normalizeProductKey('Business Loan'), 'business_loan');
    assert.equal(normalizeProductKey('business-loan'), 'business_loan');
    assert.equal(normalizeProductKey('business'), 'business_loan');
    assert.equal(normalizeProductKey('personal_loan'), 'personal_loan');
    assert.equal(normalizeProductKey(''), '');
  });

  it('reads the loan product from application data', () => {
    assert.equal(applicationProductKey({ data: JSON.stringify({ loan_type: 'business_loan' }) }), 'business_loan');
    assert.equal(applicationProductKey({ data: { loanPurpose: 'home_loan' } }), 'home_loan');
    assert.equal(applicationProductKey({ data: null }), null);
  });
});

describe('Surepass CRIF High Mark request', () => {
  it('uses the CRIF endpoint', () => {
    assert.deepEqual(getSurepassConfig({ vendor_key: 'crif_high_mark' }).paths, [
      '/api/v1/credit-report-crif/fetch-report-pdf',
    ]);
  });

  it('splits the name into first / last name as CRIF requires', () => {
    const body = buildSurepassCibilBody(
      { name: 'Anna Ram Sharma', pan: 'abcde1234f', mobile: '+91 98765 43210' },
      { vendor_key: 'crif_high_mark' },
    );
    assert.equal(body.first_name, 'Anna');
    assert.equal(body.last_name, 'Ram Sharma');
    assert.equal(body.mobile, '9876543210');
    assert.equal(body.pan, 'ABCDE1234F');
    assert.equal(body.consent, 'Y');
  });

  it('repeats a single-word name as last name (CRIF last_name is mandatory)', () => {
    const body = buildSurepassCibilBody({ name: 'Manish', mobile: '9876543210' }, { vendor_key: 'crif_high_mark' });
    assert.equal(body.first_name, 'Manish');
    assert.equal(body.last_name, 'Manish');
  });
});
