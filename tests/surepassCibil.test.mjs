import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildSurepassCibilBody,
  extractCreditScore,
  getSurepassConfig,
  surepassConfigured,
  surepassLiveMode,
} from '../src/lib/surepassCibil.js';

const PRODUCTION = 'https://kyc-api.surepass.io';
const SANDBOX = 'https://sandbox.surepass.io';

function fakeToken(identity) {
  const claims = { identity, exp: Math.floor(Date.now() / 1000) + 86400 };
  return ['h', Buffer.from(JSON.stringify(claims)).toString('base64url'), 's'].join('.');
}

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('buildSurepassCibilBody normalizes PAN, mobile and gender', () => {
  const body = buildSurepassCibilBody({
    name: ' Ramesh Kumar ',
    pan: 'abcde1234f',
    mobile: '+91 9876543210',
    gender: 'M',
  });
  assert.equal(body.name, 'Ramesh Kumar');
  assert.equal(body.pan, 'ABCDE1234F');
  assert.equal(body.mobile, '9876543210');
  assert.equal(body.gender, 'male');
  assert.equal(body.consent, 'Y');
});

test('buildSurepassCibilBody omits gender for Experian', () => {
  const body = buildSurepassCibilBody(
    { name: 'A B', pan: 'ABCDE1234F', mobile: '9876543210', gender: 'F' },
    { vendor_key: 'experian' },
  );
  assert.equal(body.gender, undefined);
});

test('extractCreditScore reads nested Surepass-style payload', () => {
  assert.equal(extractCreditScore({ data: { credit_score: 742 } }), 742);
  assert.equal(extractCreditScore({ data: { credit_score: '801' } }), 801);
  assert.equal(extractCreditScore({ data: { experian_score: 765 } }), 765);
  assert.equal(extractCreditScore({ score: 12 }), null);
});

test('surepassConfigured is false without env or vendor key', () => {
  withEnv({ SUREPASS_TOKEN: null, SUREPASS_ID_NUMBER: null, SUREPASS_PASSWORD: null }, () => {
    assert.equal(surepassConfigured({}), false);
    assert.equal(surepassConfigured({ api_key: 'tok_test' }), true);
  });
});

test('getSurepassConfig uses the fetch-report-pdf path per bureau', () => {
  withEnv({ SUREPASS_EXPERIAN_PATH: null, SUREPASS_CIBIL_PATH: '/api/v1/credit-cibil-pdf-report' }, () => {
    const experian = getSurepassConfig({ vendor_key: 'experian' });
    assert.equal(experian.isExperian, true);
    assert.deepEqual(experian.paths, ['/api/v1/credit-report-experian/fetch-report-pdf']);
    const cibil = getSurepassConfig({ vendor_key: 'transunion_cibil' });
    assert.deepEqual(cibil.paths, ['/api/v1/credit-report-cibil/fetch-report-pdf']);
  });
});

test('production token always calls the production host, even with a sandbox base URL', () => {
  withEnv(
    { SUREPASS_TOKEN: fakeToken('rfincare_1@surepass.io'), SUREPASS_BASE_URL: SANDBOX, SUREPASS_SANDBOX: 'true' },
    () => {
      const cfg = getSurepassConfig({ vendor_key: 'experian' });
      assert.equal(cfg.baseUrl, PRODUCTION);
      assert.equal(cfg.sandbox, false);
      assert.equal(surepassLiveMode(), true);
    },
  );
});

test('sandbox token always calls the sandbox host', () => {
  withEnv(
    { SUREPASS_TOKEN: fakeToken('dev.rfincare_1@surepass.io'), SUREPASS_BASE_URL: PRODUCTION, SUREPASS_SANDBOX: 'false' },
    () => {
      const cfg = getSurepassConfig({ vendor_key: 'transunion_cibil' });
      assert.equal(cfg.baseUrl, SANDBOX);
      assert.equal(cfg.sandbox, true);
      assert.equal(surepassLiveMode(), false);
    },
  );
});

test('custom gateway base URL is kept', () => {
  withEnv(
    { SUREPASS_TOKEN: fakeToken('rfincare_1@surepass.io'), SUREPASS_BASE_URL: 'https://proxy.example.com/' },
    () => {
      assert.equal(getSurepassConfig({}).baseUrl, 'https://proxy.example.com');
    },
  );
});

function expiredToken(identity) {
  const claims = { identity, exp: Math.floor(Date.now() / 1000) - 86400 };
  return ['h', Buffer.from(JSON.stringify(claims)).toString('base64url'), 's'].join('.');
}

test('valid production key saved in Admin wins over an expired sandbox server token', () => {
  const adminKey = fakeToken('rfincare_1@surepass.io');
  withEnv({ SUREPASS_TOKEN: expiredToken('dev.rfincare_1@surepass.io') }, () => {
    const cfg = getSurepassConfig({ vendor_key: 'transunion_cibil', api_key: adminKey });
    assert.equal(cfg.token, adminKey);
    assert.equal(cfg.baseUrl, PRODUCTION);
    assert.equal(cfg.sandbox, false);
  });
});

test('valid server token is kept when no admin key is saved', () => {
  const serverToken = fakeToken('rfincare_1@surepass.io');
  withEnv({ SUREPASS_TOKEN: serverToken }, () => {
    assert.equal(getSurepassConfig({ vendor_key: 'experian' }).token, serverToken);
  });
});
