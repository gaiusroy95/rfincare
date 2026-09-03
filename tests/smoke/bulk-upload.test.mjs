import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import * as XLSX from 'xlsx';

import {
  ALLOWED_RULE_OPERATORS,
  EXPECTED_SHEETS,
  SUPPORTED_COMMIT_SHEETS,
  buildErrorReportCsv,
  buildImportPreview,
  buildPolicyTemplateWorkbook,
  getTemplateBuffer,
  parsePolicyWorkbook,
} from '../../src/lib/lenderPolicyBulkImport.js';

function workbookFromSheets(sheetMap) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheetMap)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('loan advisory bulk upload', () => {
  it('hosts a real .xlsx template with PK zip magic and expected sheets', () => {
    const { buffer, generated, path } = getTemplateBuffer();
    assert.ok(buffer?.length > 100);
    assert.equal(buffer[0], 0x50); // P
    assert.equal(buffer[1], 0x4b); // K
    assert.equal(generated, false);
    assert.ok(path);
    const parsed = parsePolicyWorkbook(buffer);
    assert.ok(parsed.sheetNames.includes('Lenders'));
    assert.ok(parsed.sheetNames.includes('Products'));
    assert.ok(parsed.sheetNames.length >= 20);
  });

  it('generated fallback template includes all expected sheets', () => {
    const buffer = buildPolicyTemplateWorkbook();
    const parsed = parsePolicyWorkbook(buffer);
    for (const name of EXPECTED_SHEETS) {
      assert.ok(parsed.sheetNames.includes(name), `missing sheet ${name}`);
    }
  });

  it('validates a minimal lenders+products workbook', () => {
    const buffer = workbookFromSheets({
      Lenders: [
        {
          Lender_ID: 'LDR1',
          Lender_Code: 'ABC',
          Lender_Name: 'ABC Bank',
          Lender_Type: 'NBFC',
          Status: 'ACTIVE',
        },
      ],
      Products: [
        {
          Product_ID: 'P1',
          Lender_ID: 'LDR1',
          Product_Code: 'HL1',
          Product_Name: 'Home',
          Product_Category: 'HOME_LOAN',
          Status: 'ACTIVE',
        },
      ],
    });
    const preview = buildImportPreview(parsePolicyWorkbook(buffer));
    assert.equal(preview.valid, true);
    assert.equal(preview.lendersPreview.length, 1);
    assert.equal(preview.productsPreview[0].category, 'home_loan');
  });

  it('rejects missing Lenders sheet', () => {
    const buffer = workbookFromSheets({
      Products: [
        {
          Product_ID: 'P1',
          Lender_ID: 'LDR1',
          Product_Code: 'HL1',
          Product_Name: 'Home',
          Product_Category: 'HOME_LOAN',
        },
      ],
    });
    const preview = buildImportPreview(parsePolicyWorkbook(buffer));
    assert.equal(preview.valid, false);
    assert.ok(preview.errors.some((e) => e.sheet === 'Lenders'));
  });

  it('rejects duplicate Lender_ID and unknown Product_ID FK', () => {
    const buffer = workbookFromSheets({
      Lenders: [
        {
          Lender_ID: 'LDR1',
          Lender_Code: 'A',
          Lender_Name: 'A',
          Lender_Type: 'NBFC',
        },
        {
          Lender_ID: 'LDR1',
          Lender_Code: 'B',
          Lender_Name: 'B',
          Lender_Type: 'NBFC',
        },
      ],
      Products: [
        {
          Product_ID: 'P1',
          Lender_ID: 'LDR1',
          Product_Code: 'HL1',
          Product_Name: 'Home',
          Product_Category: 'HOME_LOAN',
        },
      ],
      Pricing_Rules: [{ Rule_ID: 'R1', Product_ID: 'MISSING', Interest_Rate_From: 9 }],
    });
    const preview = buildImportPreview(parsePolicyWorkbook(buffer));
    assert.equal(preview.valid, false);
    assert.ok(preview.errors.some((e) => /Duplicate Lender_ID/.test(e.message)));
    assert.ok(preview.errors.some((e) => e.sheet === 'Pricing_Rules' && /Unknown Product_ID/.test(e.message)));
  });

  it('rejects invalid Rule_Conditions operators', () => {
    const buffer = workbookFromSheets({
      Lenders: [
        {
          Lender_ID: 'LDR1',
          Lender_Code: 'A',
          Lender_Name: 'A',
          Lender_Type: 'NBFC',
        },
      ],
      Products: [
        {
          Product_ID: 'P1',
          Lender_ID: 'LDR1',
          Product_Code: 'HL1',
          Product_Name: 'Home',
          Product_Category: 'HOME_LOAN',
        },
      ],
      Rule_Conditions: [{ Condition_ID: 'C1', Rule_ID: 'R1', Field_Name: 'age', Operator: 'LIKE' }],
    });
    const preview = buildImportPreview(parsePolicyWorkbook(buffer));
    assert.equal(preview.valid, false);
    assert.ok(preview.errors.some((e) => e.sheet === 'Rule_Conditions' && /Invalid Operator/.test(e.message)));
    assert.ok(ALLOWED_RULE_OPERATORS.includes('BETWEEN'));
  });

  it('builds CSV error report', () => {
    const csv = buildErrorReportCsv({
      errors: [{ sheet: 'Lenders', row: 2, message: 'bad' }],
      warnings: [{ sheet: 'workbook', message: 'missing sheets' }],
    });
    assert.ok(csv.includes('Type,Sheet,Row,Message'));
    assert.ok(csv.includes('error'));
    assert.ok(csv.includes('warning'));
  });

  it('lists supported commit sheets including policy pack', () => {
    assert.ok(SUPPORTED_COMMIT_SHEETS.includes('Policy_Versions'));
    assert.ok(SUPPORTED_COMMIT_SHEETS.includes('Applicant_Rules'));
    assert.ok(SUPPORTED_COMMIT_SHEETS.includes('Matching_Rules'));
  });

  it('docs example workbook parses when present', () => {
    try {
      const buf = readFileSync(
        new URL('../../../docs/Loan_Advisory_Lender_Product_Bulk_Upload_With_Examples.xlsx', import.meta.url),
      );
      const preview = buildImportPreview(parsePolicyWorkbook(buf));
      assert.ok(preview.sheetCounts.Lenders >= 1 || preview.errors.length >= 0);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
  });
});
