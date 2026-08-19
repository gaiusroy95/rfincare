import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildSurepassCibilBody,
  extractCreditScore,
  surepassConfigured,
} from '../src/lib/surepassCibil.js';

test('buildSurepassCibilBody normalizes PAN, mobile, DOB, gender', () => {
  const body = buildSurepassCibilBody({
    name: 'Ramesh Kumar',
    pan: 'abcde1234f',
    mobile: '+91 9876543210',
    dob: '1990-01-15',
    gender: 'M',
  });
  assert.equal(body.pan, 'ABCDE1234F');
  assert.equal(body.mobile_no, '9876543210');
  assert.equal(body.dob, '15-01-1990');
  assert.equal(body.gender, 'male');
  assert.equal(body.consent, 'Y');
});

test('extractCreditScore reads nested Surepass-style payload', () => {
  assert.equal(extractCreditScore({ data: { credit_score: 742 } }), 742);
  assert.equal(extractCreditScore({ data: { cibil_score: '801' } }), 801);
  assert.equal(extractCreditScore({ score: 12 }), null);
});

test('surepassConfigured is false without env or vendor key', () => {
  assert.equal(surepassConfigured({}), false);
  assert.equal(surepassConfigured({ api_key: 'tok_test' }), true);
});
