import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MIN_APPLICANT_AGE,
  getApplicantAge,
  isApplicantAgeEligible,
} from '../../src/lib/applicantAge.js';
import { DEFAULT_MATCHING_WEIGHTS } from '../../src/lib/matchingConfig.js';

describe('Customer Journey — age policy', () => {
  it('sets minimum applicant age to 21', () => {
    assert.equal(MIN_APPLICANT_AGE, 21);
  });

  it('treats the 21st birthday as eligible and younger as ineligible', () => {
    const today = new Date(2026, 8, 3);
    assert.equal(getApplicantAge(new Date(2005, 8, 3), today), 21);
    assert.equal(isApplicantAgeEligible(new Date(2005, 8, 3), today), true);
    assert.equal(getApplicantAge(new Date(2005, 8, 4), today), 20);
    assert.equal(isApplicantAgeEligible(new Date(2005, 8, 4), today), false);
    assert.equal(isApplicantAgeEligible(new Date(2004, 0, 1), today), true);
    assert.equal(isApplicantAgeEligible('', today), false);
    assert.equal(isApplicantAgeEligible(null, today), false);
  });
});

describe('Customer Journey — pass-matrix weights', () => {
  it('scores age and employment stability in matching config', () => {
    assert.ok(DEFAULT_MATCHING_WEIGHTS.age_mismatch > 0);
    assert.ok(DEFAULT_MATCHING_WEIGHTS.stability_mismatch > 0);
  });
});
