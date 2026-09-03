import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LOCATION_MAPPED_REMARK,
  LOCATION_NOT_COVERED_REMARK,
  applyLocationServiceabilityGate,
  normalizeApplicationPincode,
  pickServiceabilityRow,
} from '../../src/lib/lenderPinServiceability.js';

describe('lender PIN serviceability', () => {
  it('normalizes PIN to 6 digits', () => {
    assert.equal(normalizeApplicationPincode('400 053'), '400053');
    assert.equal(normalizeApplicationPincode('12'), null);
  });

  it('prefers product-specific serviceability row', () => {
    const rows = [
      { bank_id: 'b1', bank_product_id: null, status: 'serviceable' },
      { bank_id: 'b1', bank_product_id: 'p1', status: 'not_serviceable' },
    ];
    const picked = pickServiceabilityRow(rows, { bankId: 'b1', bankProductId: 'p1' });
    assert.equal(picked.status, 'not_serviceable');
  });

  it('marks mapped PIN after FOIR/LTV with location is mapped', () => {
    const result = applyLocationServiceabilityGate({
      pincode: '400001',
      bankHasCoverageList: true,
      row: { status: 'serviceable' },
      decision: 'ELIGIBLE',
      decisionReason: 'Meets probability and soft rules',
      probability: 82,
      eligibleAmount: 500000,
    });
    assert.equal(result.decision, 'ELIGIBLE');
    assert.equal(result.locationRemark, LOCATION_MAPPED_REMARK);
    assert.equal(result.eligibleAmount, 500000);
    assert.match(result.decisionReason, /location is mapped/);
  });

  it('rejects uncovered PIN with location not covered by bank', () => {
    const result = applyLocationServiceabilityGate({
      pincode: '999999',
      bankHasCoverageList: true,
      row: null,
      decision: 'ELIGIBLE',
      decisionReason: 'Meets probability and soft rules',
      probability: 90,
      eligibleAmount: 900000,
    });
    assert.equal(result.decision, 'NOT_ELIGIBLE');
    assert.equal(result.locationRemark, LOCATION_NOT_COVERED_REMARK);
    assert.equal(result.probability, 0);
    assert.equal(result.eligibleAmount, 0);
  });

  it('fails open when bank has no coverage list uploaded', () => {
    const result = applyLocationServiceabilityGate({
      pincode: '400001',
      bankHasCoverageList: false,
      row: null,
      decision: 'ELIGIBLE',
      decisionReason: 'Meets probability and soft rules',
      probability: 75,
      eligibleAmount: 100000,
    });
    assert.equal(result.decision, 'ELIGIBLE');
    assert.equal(result.locationRemark, null);
    assert.equal(result.eligibleAmount, 100000);
  });
});
