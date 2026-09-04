import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LEGAL_PAGE_CATALOG,
  getCatalogLegalPage,
  listCatalogLegalPages,
} from '../../src/lib/legalPages.js';

describe('legal pages catalog', () => {
  it('includes all Policies & Disclosures slugs used by the footer/admin UI', () => {
    const required = [
      'disclaimer',
      'grievance-redressal-policy',
      'fair-practices-code',
      'kyc-aml-policy',
      'refund-cancellation-policy',
      'data-retention-policy',
      'consent-data-collection-credit-bureau',
      'digital-lending-disclosure',
      'partner-bank-nbfc-disclosure',
      'code-of-conduct-dsa-employees',
      'security-fraud-awareness',
      'accessibility-statement',
    ];
    for (const slug of required) {
      const page = getCatalogLegalPage(slug);
      assert.ok(page, `missing catalog page ${slug}`);
      assert.ok(page.bodyHtml.includes('<'), `${slug} should have HTML starter content`);
      assert.ok(page.bodyHtml.length > 200, `${slug} starter content too short`);
    }
  });

  it('includes general legal pages', () => {
    for (const slug of [
      'privacy-policy',
      'terms-of-service',
      'cookie-policy',
      'help-center',
      'financial-guides',
      'careers',
    ]) {
      assert.ok(getCatalogLegalPage(slug), slug);
    }
  });

  it('has unique slugs', () => {
    const slugs = LEGAL_PAGE_CATALOG.map((p) => p.slug);
    assert.equal(new Set(slugs).size, slugs.length);
    assert.equal(listCatalogLegalPages().length, LEGAL_PAGE_CATALOG.length);
  });
});
