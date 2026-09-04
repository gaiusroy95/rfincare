import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  GEO_MESSAGES,
  buildAddressPinChecks,
  buildOverallGeoMessage,
  evaluateBankGeoCoverage,
  isPurchaseOrConstructionPurpose,
  matchBankGeoForPin,
  partitionBanksByGeo,
} from '../../src/lib/lenderGeoEligibility.js';

describe('lender geo eligibility', () => {
  it('detects purchase/construction purpose', () => {
    assert.equal(isPurchaseOrConstructionPurpose('home_purchase'), true);
    assert.equal(isPurchaseOrConstructionPurpose('personal_loan'), false);
  });

  it('PIN EXCLUDE overrides broader include via pin match', () => {
    const rows = [
      { pincode: '334001', coverage_type: 'INCLUDE', geo_level: 'pincode' },
      { pincode: '334009', coverage_type: 'EXCLUDE', geo_level: 'pincode' },
      { district_name: 'Bikaner', coverage_type: 'INCLUDE', geo_level: 'district' },
    ];
    const excluded = matchBankGeoForPin(rows, { pincode: '334009', districtName: 'Bikaner' });
    assert.equal(excluded.outcome, 'excluded');
    const covered = matchBankGeoForPin(rows, { pincode: '334001', districtName: 'Bikaner' });
    assert.equal(covered.outcome, 'covered');
    const inherited = matchBankGeoForPin(rows, { pincode: '334050', districtName: 'Bikaner' });
    assert.equal(inherited.outcome, 'covered');
    assert.equal(inherited.matchedLevel, 'district');
  });

  it('unsecured permanent fallback yields in_review not full covered', () => {
    const checks = buildAddressPinChecks(
      { pincode: '110001', permanentPincode: '334001', loanType: 'personal_loan' },
      { loanCategory: 'unsecured' },
    );
    const rows = [{ pincode: '334001', coverage_type: 'INCLUDE', geo_level: 'pincode' }];
    const result = evaluateBankGeoCoverage({
      bankHasGeoPolicy: true,
      coverageRows: rows,
      addressChecks: checks,
    });
    assert.equal(result.geoStatus, 'in_review');
    assert.equal(result.showInScoredList, false);
    assert.equal(result.customerMessageKey, 'inReview');
  });

  it('skips geo when bank has no policy', () => {
    const checks = buildAddressPinChecks({ pincode: '110001' }, { loanCategory: 'unsecured' });
    const result = evaluateBankGeoCoverage({
      bankHasGeoPolicy: false,
      coverageRows: [],
      addressChecks: checks,
    });
    assert.equal(result.geoStatus, 'skipped');
    assert.equal(result.showInScoredList, true);
  });

  it('partitions scored vs in-review banks and builds overall message', () => {
    const { scored, inReview } = partitionBanksByGeo([
      { bankName: 'A', showInScoredList: true, geoStatus: 'covered' },
      { bankName: 'B', showInScoredList: false, geoStatus: 'not_covered' },
    ]);
    assert.equal(scored.length, 1);
    assert.equal(inReview.length, 1);
    assert.equal(buildOverallGeoMessage({ scored, inReview }), GEO_MESSAGES.covered);
  });

  it('secured purchase requires property pin checks', () => {
    const checks = buildAddressPinChecks(
      {
        loanType: 'home_purchase',
        currentPincode: '110001',
        propertyPincode: '334001',
      },
      { loanCategory: 'secured' },
    );
    assert.equal(checks.mode, 'secured_purchase_construction');
    assert.equal(checks.requireAll, true);
    assert.equal(checks.pins.length, 2);
  });
});
