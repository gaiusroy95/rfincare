import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  evaluateCondition,
  summarizeDecision,
} from '../../src/lib/ruleEngine.js';
import { listEngineEligibilityRules } from '../../src/lib/policyConsole.js';
import {
  DEFAULT_MATCHING_WEIGHTS,
  DEFAULT_DECISION_THRESHOLDS,
} from '../../src/lib/matchingConfig.js';
import { extractFieldsFromText as ocrExtract } from '../../src/lib/documentOcr.js';

describe('upgrade QC — rule engine', () => {
  it('evaluates >= on credit score', () => {
    const r = evaluateCondition(
      { field_key: 'credit_score', operator: '>=', value_json: 700 },
      { creditScore: 750 },
    );
    assert.equal(r.pass, true);
  });

  it('evaluates BETWEEN on age', () => {
    const r = evaluateCondition(
      { field_key: 'age', operator: 'BETWEEN', value_json: 21, value_to_json: 60 },
      { age: 35 },
    );
    assert.equal(r.pass, true);
  });

  it('critical fail drives NOT_ELIGIBLE', () => {
    const rules = [
      {
        ruleId: '1',
        ruleName: 'Min CIBIL',
        severity: 'critical',
        status: 'FAIL',
        pass: false,
      },
    ];
    const d = summarizeDecision(rules, {
      eligibleMin: 70,
      conditionalMin: 50,
      probability: 80,
    });
    assert.equal(d.decision, 'NOT_ELIGIBLE');
  });

  it('high probability yields ELIGIBLE when no critical fail', () => {
    const d = summarizeDecision([], {
      eligibleMin: 70,
      conditionalMin: 50,
      probability: 85,
    });
    assert.equal(d.decision, 'ELIGIBLE');
  });
});

describe('upgrade QC — OCR field extraction', () => {
  it('extracts PAN from sample text', () => {
    const fields = ocrExtract('PAN ABCDE1234F issued by ITD', 'pan');
    assert.equal(fields.pan, 'ABCDE1234F');
  });

  it('extracts 12-digit Aadhaar', () => {
    const fields = ocrExtract('Aadhaar 1234 5678 9012 UIDAI', 'aadhaar');
    assert.equal(fields.aadhaar, '123456789012');
  });
});

describe('upgrade QC — matching defaults', () => {
  it('has expected default weight keys', () => {
    assert.ok(DEFAULT_MATCHING_WEIGHTS.income_mismatch > 0);
    assert.ok(DEFAULT_MATCHING_WEIGHTS.critical_fail_penalty > 0);
    assert.equal(DEFAULT_DECISION_THRESHOLDS.eligible_min_probability, 70);
  });
});

describe('upgrade QC — module imports', () => {
  it('loads policy console, geo, locations route, admin policy route', async () => {
    await import('../../src/lib/policyConsole.js');
    await import('../../src/lib/geoHierarchy.js');
    await import('../../src/routes/locations.js');
    await import('../../src/routes/adminPolicyConsole.js');
    await import('../../src/routes/adminIntegrations.js');
    await import('../../src/lib/documentOcr.js');
    await import('../../src/lib/lenderPolicyBulkImport.js');
    await import('../../src/lib/lenderMaster.js');
    await import('../../src/routes/adminLenderMaster.js');
  });

  it('exports listEngineEligibilityRules for published-policy matching', async () => {
    assert.equal(typeof listEngineEligibilityRules, 'function');
  });

  it('creates express app without throw', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = createApp({ serveStatic: false });
    assert.ok(app);
  });
});
