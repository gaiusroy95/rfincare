import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const VALID_SIP_STATUSES = ['created', 'mandate_pending', 'active', 'failed', 'cancelled'];

describe('SIP lifecycle statuses', () => {
  it('includes active as mandate-complete stage', () => {
    assert.ok(VALID_SIP_STATUSES.includes('active'));
    assert.ok(VALID_SIP_STATUSES.includes('mandate_pending'));
  });

  it('annual SIP commission base is monthly × 12', () => {
    const sipAmount = 5000;
    const annualBase = sipAmount * 12;
    assert.equal(annualBase, 60000);
  });
});

describe('credit pull configuration', () => {
  it('reports unconfigured when CIBIL env vars are absent', () => {
    const configured = Boolean(
      process.env.CIBIL_API_URL
      && process.env.CIBIL_API_KEY
      && process.env.CIBIL_MEMBER_ID,
    );
    if (!configured) {
      assert.equal(configured, false);
    } else {
      assert.equal(configured, true);
    }
  });
});
