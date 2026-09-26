import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

import { getPool } from '../db/pool.js';
import { newId } from './ids.js';
import {
  ensurePolicyConsoleSchema,
  createDraftVersion,
  createEligibilityRule,
  writePolicyAudit,
} from './policyConsole.js';
import { saveMatchingConfig } from './matchingConfig.js';
import { createGeoVersionFromSheetRows, ensureLenderGeoPolicySchema } from './lenderGeoPolicy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SUPPORTED_COMMIT_SHEETS = [
  'Lenders',
  'Products',
  'Pricing_Rules',
  'Document_Rules',
  'Fees',
  'Obligation_Rules',
  'Policy_Versions',
  'Applicant_Rules',
  'Income_Rules',
  'Employment_Rules',
  'Business_Rules',
  'Credit_Rules',
  'Banking_Rules',
  'LTV_Rules',
  'Matching_Rules',
  'Risk_Rules',
  'Exceptions',
  'Geo_Coverage',
  'Location_Rules',
];

export const EXPECTED_SHEETS = [
  'README',
  'Lenders',
  'Products',
  'Applicant_Rules',
  'Income_Rules',
  'Employment_Rules',
  'Business_Rules',
  'Credit_Rules',
  'Banking_Rules',
  'Obligation_Rules',
  'Property_Rules',
  'Legal_Rules',
  'Location_Rules',
  'LTV_Rules',
  'Tenure_Rules',
  'Pricing_Rules',
  'Document_Rules',
  'Risk_Rules',
  'Exceptions',
  'Fees',
  'Location_Master',
  'Property_Master',
  'Geo_Coverage',
  'Policy_Versions',
  'Rule_Conditions',
  'Matching_Rules',
];

const LENDER_REQUIRED = ['Lender_ID', 'Lender_Code', 'Lender_Name', 'Lender_Type'];
const PRODUCT_REQUIRED = [
  'Product_ID',
  'Lender_ID',
  'Product_Code',
  'Product_Name',
  'Product_Category',
];

/** Operators allowed on Rule_Conditions (and optional Operator columns on rule sheets). */
export const ALLOWED_RULE_OPERATORS = [
  '=',
  '!=',
  '>',
  '<',
  '>=',
  '<=',
  'IN',
  'BETWEEN',
  'CONTAINS',
];

const PRODUCT_FK_SHEETS = [
  'Pricing_Rules',
  'Document_Rules',
  'Fees',
  'Obligation_Rules',
  'Applicant_Rules',
  'Income_Rules',
  'Employment_Rules',
  'Business_Rules',
  'Credit_Rules',
  'Banking_Rules',
  'LTV_Rules',
  'Matching_Rules',
  'Risk_Rules',
  'Exceptions',
  'Policy_Versions',
  'Tenure_Rules',
  'Property_Rules',
  'Legal_Rules',
  'Location_Rules',
];

const SHEET_HEADER_SAMPLES = {
  Lenders: [
    {
      Lender_ID: 'LDR001',
      Lender_Code: 'DEMO_BANK',
      Lender_Name: 'Demo Bank Ltd',
      Lender_Type: 'NBFC',
      Status: 'ACTIVE',
    },
  ],
  Products: [
    {
      Product_ID: 'PRD001',
      Lender_ID: 'LDR001',
      Product_Code: 'HL_DEMO',
      Product_Name: 'Demo Home Loan',
      Product_Category: 'home_loan',
      Status: 'ACTIVE',
      Apply_URL: 'https://bank.example.com/apply',
      Interest_Rate_From: 8.5,
      Interest_Rate_To: 11.5,
      Processing_Fee_Percentage: 1,
      Processing_Fee_Fixed: '',
      Other_Charges: 'Legal fee, stamp duty, GST on fees',
      Prepayment_Charges: 'Nil after 12 EMIs',
      Foreclosure_Charges: 'As per bank policy',
      Foreclosure_Fee_Pct: 4,
      Foreclosure_Allowed_After_Months: 12,
      Part_Payment_Fee_Pct: 2,
      Bouncing_Charges: 500,
      Late_Fee_Pct: 2,
      Late_Payment_Fee_Fixed: '',
      Late_Payment_Charges: '2% of EMI or ₹500',
      Documentation_Charges: 'As applicable',
      Minimum_Loan_Amount: 500000,
      Maximum_Loan_Amount: 50000000,
      Minimum_Tenure_Years: 1,
      Maximum_Tenure_Years: 30,
      Minimum_Tenure_Months: 12,
      Maximum_Tenure_Months: 360,
      Disbursal_Timeline: '48-72 hours after approval',
      Collateral_Required: 'None / Property mortgage',
      Features: 'Up to ₹2 Cr|Flexible repayment',
      Eligibility_Criteria: 'Minimum age 21|Minimum annual income ₹5 Lakh',
      Policies: 'No co-applicant required|Balance transfer allowed',
      Documentation_Required: 'PAN & Aadhaar|Last 3 months salary slips',
      Product_Type: 'Floating',
      Target_Customer: 'Salaried',
      Purpose: 'Purchase',
      Policy_Version: 'v1',
    },
  ],
  Applicant_Rules: [{ Rule_ID: 'APP001', Product_ID: 'PRD001', Minimum_Age: 21, Maximum_Age: 65 }],
  Income_Rules: [{ Rule_ID: 'INC001', Product_ID: 'PRD001', Minimum_Income: 25000 }],
  Employment_Rules: [{ Rule_ID: 'EMP001', Product_ID: 'PRD001', Minimum_Years_Employed: 1 }],
  Business_Rules: [{ Rule_ID: 'BUS001', Product_ID: 'PRD001', Minimum_Years_In_Business: 2 }],
  Credit_Rules: [{ Rule_ID: 'CR001', Product_ID: 'PRD001', Minimum_CIBIL: 650, Maximum_CIBIL: 900 }],
  Banking_Rules: [{ Rule_ID: 'BNK001', Product_ID: 'PRD001', Minimum_Average_Balance: 10000 }],
  Obligation_Rules: [{ Rule_ID: 'OBL001', Product_ID: 'PRD001', Maximum_FOIR_Percentage: 55 }],
  Property_Rules: [{ Rule_ID: 'PROP001', Product_ID: 'PRD001', Property_Type: 'residential' }],
  Legal_Rules: [{ Rule_ID: 'LEG001', Product_ID: 'PRD001', Title_Clear: 'YES' }],
  Location_Rules: [
    {
      Lender_Code: 'DEMO_BANK',
      PIN_Code: '110001',
      Coverage_Type: 'INCLUDE',
      State: 'Delhi',
      District: 'New Delhi',
      Remarks: 'Legacy Location_Rules alias — prefer Geo_Coverage',
    },
  ],
  Geo_Coverage: [
    {
      Lender_Code: 'DEMO_BANK',
      State: 'Rajasthan',
      District: 'Bikaner',
      Tehsil: 'Bikaner',
      PIN_Code: '334001',
      Coverage_Type: 'INCLUDE',
      Branch_Code: '',
      Radius_KM: '',
      Effective_From: '2026-09-01',
      Effective_To: '',
      Remarks: 'Standard coverage',
      Change_Reason: 'Initial geo upload',
    },
    {
      Lender_Code: 'DEMO_BANK',
      State: 'Rajasthan',
      District: 'Bikaner',
      Tehsil: 'Bikaner',
      PIN_Code: '334009',
      Coverage_Type: 'EXCLUDE',
      Remarks: 'Negative PIN',
      Change_Reason: 'Initial geo upload',
    },
  ],
  LTV_Rules: [{ Rule_ID: 'LTV001', Product_ID: 'PRD001', Property_Type: 'residential', Maximum_LTV: 0.8 }],
  Tenure_Rules: [{ Rule_ID: 'TEN001', Product_ID: 'PRD001', Minimum_Tenure_Months: 12, Maximum_Tenure_Months: 360 }],
  Pricing_Rules: [
    {
      Rule_ID: 'PRC001',
      Product_ID: 'PRD001',
      Minimum_CIBIL: 650,
      Maximum_CIBIL: 900,
      Interest_Rate_From: 8.5,
      Interest_Rate_To: 11.5,
      Risk_Grade: 'A',
    },
  ],
  Document_Rules: [
    {
      Rule_ID: 'DOC001',
      Product_ID: 'PRD001',
      Document_Code: 'PAN',
      Document_Name: 'PAN Card',
      Requirement_Status: 'MANDATORY',
    },
  ],
  Risk_Rules: [{ Rule_ID: 'RSK001', Product_ID: 'PRD001', Severity: 'soft', Description: 'Demo risk' }],
  Exceptions: [{ Exception_ID: 'EX001', Product_ID: 'PRD001', Description: 'Demo exception' }],
  Fees: [
    {
      Fee_ID: 'FEE001',
      Product_ID: 'PRD001',
      Fee_Type: 'Processing',
      Calculation_Method: 'PERCENTAGE',
      Value: 1,
    },
  ],
  Location_Master: [{ PIN_Code: '110001', City: 'New Delhi', State: 'Delhi' }],
  Property_Master: [{ Property_Type: 'residential', Description: 'Flat / apartment' }],
  Policy_Versions: [
    {
      Product_ID: 'PRD001',
      Version_Label: 'v1',
      Policy_Version: 'v1',
      Change_Reason: 'Initial bulk template',
      Effective_From: '2026-01-01',
    },
  ],
  Rule_Conditions: [
    {
      Condition_ID: 'COND001',
      Rule_ID: 'APP001',
      Field_Name: 'age',
      Operator: 'BETWEEN',
      Value: 21,
      Max_Value: 65,
    },
  ],
  Matching_Rules: [{ Factor: 'interest_rate', Weight_Key: 'interest_rate', Weight: 40 }],
};

function normalizeKey(key) {
  return String(key || '')
    .trim()
    .replace(/\s+/g, '_');
}

function sheetToRows(sheet) {
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  return rows.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      out[normalizeKey(k)] = typeof v === 'string' ? v.trim() : v;
    }
    return out;
  });
}

function mapLenderType(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (t === 'hfc' || t.includes('housing')) return 'hfc';
  if (t === 'nbfc') return 'nbfc';
  if (t === 'public' || t.includes('public')) return 'public';
  if (t === 'foreign') return 'foreign';
  if (t === 'cooperative' || t.includes('coop')) return 'cooperative';
  if (t === 'bank' || t === 'private') return 'private';
  return t || 'private';
}

function mapProductCategory(category) {
  const c = String(category || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  const map = {
    HOME_LOAN: { slug: 'home_loan', loanType: 'home_loan' },
    HL: { slug: 'home_loan', loanType: 'home_loan' },
    LAP: { slug: 'loan_against_property', loanType: 'home_loan' },
    LOAN_AGAINST_PROPERTY: { slug: 'loan_against_property', loanType: 'home_loan' },
    BUSINESS_LOAN: { slug: 'business_loan', loanType: 'business_loan' },
    PERSONAL_LOAN: { slug: 'personal_loan', loanType: 'personal_loan' },
    MORTGAGE: { slug: 'mortgage_loan', loanType: 'home_loan' },
    MORTGAGE_LOAN: { slug: 'mortgage_loan', loanType: 'home_loan' },
    PLOT: { slug: 'home_loan', loanType: 'home_loan' },
    PLOT_CONSTRUCTION: { slug: 'home_loan', loanType: 'home_loan' },
  };
  return map[c] || { slug: c.toLowerCase() || 'home_loan', loanType: 'home_loan' };
}

function toNumber(value, fallback = null) {
  if (value === '' || value == null) return fallback;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

/** Set number only when cell has a value (empty Excel cells do not wipe existing product data). */
function assignNumber(target, key, raw) {
  if (raw === '' || raw == null) return;
  const n = toNumber(raw);
  if (n != null) target[key] = n;
}

/** Set trimmed text only when non-empty. */
function assignText(target, key, raw) {
  if (raw === '' || raw == null) return;
  const s = String(raw).trim();
  if (s) target[key] = s;
}

function firstPresent(row, ...keys) {
  for (const key of keys) {
    if (row?.[key] !== undefined && row?.[key] !== null && String(row[key]).trim() !== '') {
      return row[key];
    }
  }
  return undefined;
}

function toDateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function statusActive(raw) {
  const s = String(raw || 'ACTIVE').toUpperCase();
  return s === 'ACTIVE' || s === 'LIVE' || s === 'PUBLISHED';
}

export function resolvePolicyTemplatePath() {
  const candidates = [
    resolve(__dirname, '../../assets/templates/loan-advisory-lender-product-bulk-upload.xlsx'),
    resolve(process.cwd(), 'assets/templates/loan-advisory-lender-product-bulk-upload.xlsx'),
    resolve(process.cwd(), '../docs/Loan_Advisory_Lender_Product_Bulk_Upload_With_Examples.xlsx'),
    resolve(__dirname, '../../../docs/Loan_Advisory_Lender_Product_Bulk_Upload_With_Examples.xlsx'),
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

export function parsePolicyWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheets = {};
  for (const name of wb.SheetNames) {
    sheets[name] = sheetToRows(wb.Sheets[name]);
  }
  return { sheetNames: wb.SheetNames, sheets };
}

function validateRequiredColumns(rows, required, sheetName, errors) {
  if (!rows.length) {
    errors.push({ sheet: sheetName, row: 0, message: 'Sheet has no data rows' });
    return;
  }
  const keys = Object.keys(rows[0]);
  for (const col of required) {
    if (!keys.includes(col)) {
      errors.push({ sheet: sheetName, row: 0, message: `Missing required column: ${col}` });
    }
  }
}

export function buildImportPreview(parsed) {
  const errors = [];
  const warnings = [];
  const sheets = parsed.sheets || {};
  const sheetNames = parsed.sheetNames || Object.keys(sheets);

  const missingExpected = EXPECTED_SHEETS.filter((n) => !sheetNames.includes(n));
  if (missingExpected.length) {
    warnings.push({
      sheet: 'workbook',
      message: `Expected sheets not present: ${missingExpected.join(', ')}`,
    });
  }

  if (!sheetNames.includes('Lenders')) {
    errors.push({ sheet: 'Lenders', row: 0, message: 'Lenders sheet is required' });
  }
  if (!sheetNames.includes('Products')) {
    errors.push({ sheet: 'Products', row: 0, message: 'Products sheet is required' });
  }

  const lenders = sheets.Lenders || [];
  const products = sheets.Products || [];
  if (lenders.length) validateRequiredColumns(lenders, LENDER_REQUIRED, 'Lenders', errors);
  if (products.length) validateRequiredColumns(products, PRODUCT_REQUIRED, 'Products', errors);

  const lenderIds = new Set();
  lenders.forEach((row, idx) => {
    if (!row.Lender_ID) {
      errors.push({ sheet: 'Lenders', row: idx + 2, message: 'Lender_ID is required' });
    } else if (lenderIds.has(row.Lender_ID)) {
      errors.push({ sheet: 'Lenders', row: idx + 2, message: `Duplicate Lender_ID ${row.Lender_ID}` });
    } else {
      lenderIds.add(row.Lender_ID);
    }
    if (!row.Lender_Code) {
      errors.push({ sheet: 'Lenders', row: idx + 2, message: 'Lender_Code is required' });
    }
    if (!row.Lender_Name) {
      errors.push({ sheet: 'Lenders', row: idx + 2, message: 'Lender_Name is required' });
    }
  });

  const productIds = new Set();
  products.forEach((row, idx) => {
    if (!row.Product_ID) {
      errors.push({ sheet: 'Products', row: idx + 2, message: 'Product_ID is required' });
    } else if (productIds.has(row.Product_ID)) {
      errors.push({ sheet: 'Products', row: idx + 2, message: `Duplicate Product_ID ${row.Product_ID}` });
    } else {
      productIds.add(row.Product_ID);
    }
    if (!lenderIds.has(row.Lender_ID)) {
      errors.push({
        sheet: 'Products',
        row: idx + 2,
        message: `Unknown Lender_ID ${row.Lender_ID}`,
      });
    }
  });

  // Cross-sheet FK checks for known rule sheets
  for (const sheet of PRODUCT_FK_SHEETS) {
    (sheets[sheet] || []).forEach((row, idx) => {
      if (row.Product_ID && !productIds.has(row.Product_ID)) {
        errors.push({
          sheet,
          row: idx + 2,
          message: `Unknown Product_ID ${row.Product_ID}`,
        });
      }
    });
  }

  const allowedOps = new Set(ALLOWED_RULE_OPERATORS.map((o) => o.toUpperCase()));
  (sheets.Rule_Conditions || []).forEach((row, idx) => {
    const op = String(row.Operator || '').trim().toUpperCase();
    if (!op) {
      errors.push({
        sheet: 'Rule_Conditions',
        row: idx + 2,
        message: 'Operator is required',
      });
      return;
    }
    if (!allowedOps.has(op)) {
      errors.push({
        sheet: 'Rule_Conditions',
        row: idx + 2,
        message: `Invalid Operator "${row.Operator}". Allowed: ${ALLOWED_RULE_OPERATORS.join(', ')}`,
      });
    }
    if (op === 'BETWEEN' && (row.Value === '' || row.Value == null) && (row.Min_Value === '' || row.Min_Value == null)) {
      warnings.push({
        sheet: 'Rule_Conditions',
        row: idx + 2,
        message: 'BETWEEN typically needs Value/Min_Value and Max_Value',
      });
    }
  });

  const decisionAllowed = new Set(['PASS', 'REVIEW', 'FAIL']);
  for (const sheet of ['Applicant_Rules', 'Credit_Rules', 'Risk_Rules', 'Exceptions']) {
    (sheets[sheet] || []).forEach((row, idx) => {
      const action = String(row.Decision_Action || row.Action || '').trim().toUpperCase();
      if (action && !decisionAllowed.has(action)) {
        warnings.push({
          sheet,
          row: idx + 2,
          message: `Unrecognized Decision_Action "${row.Decision_Action || row.Action}" (expected PASS / REVIEW / FAIL)`,
        });
      }
    });
  }

  const unsupportedSheets = sheetNames.filter(
    (n) => n !== 'README' && !SUPPORTED_COMMIT_SHEETS.includes(n),
  );
  if (unsupportedSheets.length) {
    warnings.push({
      sheet: 'workbook',
      message: `Sheets stored on job but not dual-written on publish: ${unsupportedSheets.join(', ')}`,
    });
  }

  const sheetCounts = Object.fromEntries(
    sheetNames.map((n) => [n, (sheets[n] || []).length]),
  );

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    sheetCounts,
    unsupportedSheets,
    lendersPreview: lenders.slice(0, 20).map((r) => ({
      lenderId: r.Lender_ID,
      lenderCode: r.Lender_Code,
      name: r.Lender_Name,
      type: mapLenderType(r.Lender_Type),
      status: statusActive(r.Status) ? 'active' : 'inactive',
    })),
    productsPreview: products.slice(0, 30).map((r) => {
      const cat = mapProductCategory(r.Product_Category);
      return {
        productId: r.Product_ID,
        lenderId: r.Lender_ID,
        productCode: r.Product_Code,
        name: r.Product_Name,
        category: cat.slug,
        rateFrom: toNumber(r.Interest_Rate_From),
        rateTo: toNumber(r.Interest_Rate_To),
        status: statusActive(r.Status) ? 'active' : 'inactive',
      };
    }),
    commitSheets: SUPPORTED_COMMIT_SHEETS.filter((n) => sheetNames.includes(n)),
  };
}

async function ensureImportSchema(pool) {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS lender_policy_import_jobs (
      id CHAR(36) NOT NULL,
      file_name VARCHAR(512) NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'validated',
      summary_json JSON NULL,
      preview_json JSON NULL,
      unsupported_sheets_json JSON NULL,
      sheet_payload_json JSON NULL,
      error_report_json JSON NULL,
      commit_result_json JSON NULL,
      created_by CHAR(36) NULL,
      committed_by CHAR(36) NULL,
      committed_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )
  `);
  try {
    await pool.execute(`ALTER TABLE banks ADD COLUMN IF NOT EXISTS lender_code VARCHAR(64) NULL`);
    await pool.execute(`ALTER TABLE banks ADD COLUMN IF NOT EXISTS effective_from DATE NULL`);
    await pool.execute(`ALTER TABLE banks ADD COLUMN IF NOT EXISTS policy_source VARCHAR(255) NULL`);
  } catch {
    /* ignore if dialect differs */
  }
}

function parseProductData(data) {
  if (!data) return {};
  if (typeof data === 'object') return { ...data };
  try {
    return JSON.parse(data) || {};
  } catch {
    return {};
  }
}

export async function saveValidatedImportJob({
  fileName,
  parsed,
  preview,
  createdBy,
}) {
  const pool = getPool();
  await ensureImportSchema(pool);
  const id = newId();
  await pool.execute(
    `INSERT INTO lender_policy_import_jobs (
       id, file_name, status, summary_json, preview_json, unsupported_sheets_json,
       sheet_payload_json, error_report_json, created_by
     ) VALUES (
       :id, :file_name, :status, :summary_json, :preview_json, :unsupported_sheets_json,
       :sheet_payload_json, :error_report_json, :created_by
     )`,
    {
      id,
      file_name: fileName || null,
      status: preview.valid ? 'validated' : 'invalid',
      summary_json: JSON.stringify({
        sheetCounts: preview.sheetCounts,
        commitSheets: preview.commitSheets,
      }),
      preview_json: JSON.stringify(preview),
      unsupported_sheets_json: JSON.stringify(preview.unsupportedSheets || []),
      sheet_payload_json: JSON.stringify(parsed.sheets || {}),
      error_report_json: JSON.stringify({
        errors: preview.errors,
        warnings: preview.warnings,
      }),
      created_by: createdBy || null,
    },
  );
  return id;
}

export async function getImportJob(jobId) {
  const pool = getPool();
  await ensureImportSchema(pool);
  const [[row]] = await pool.execute(
    `SELECT * FROM lender_policy_import_jobs WHERE id = :id LIMIT 1`,
    { id: jobId },
  );
  return row || null;
}

export async function listImportJobs(limit = 30) {
  const pool = getPool();
  await ensureImportSchema(pool);
  const [rows] = await pool.execute(
    `SELECT id, file_name, status, summary_json, unsupported_sheets_json,
            created_by, committed_by, committed_at, created_at
     FROM lender_policy_import_jobs
     ORDER BY created_at DESC
     LIMIT :lim`,
    { lim: Number(limit) || 30 },
  );
  return rows;
}

async function upsertLender(conn, row, createdBy, idMap) {
  const lenderCode = String(row.Lender_Code || '').trim().toUpperCase();
  const name = String(row.Lender_Name || '').trim();
  const bankType = mapLenderType(row.Lender_Type);
  const status = statusActive(row.Status) ? 'active' : 'inactive';
  const priority = toNumber(row.Priority, 0) || 0;
  const effectiveFrom = toDateOrNull(row.Effective_From);
  const policySource = row.Policy_Source || null;

  const [[byCode]] = await conn.execute(
    `SELECT id FROM banks WHERE UPPER(TRIM(COALESCE(lender_code, ''))) = :code LIMIT 1`,
    { code: lenderCode },
  );
  let bankId = byCode?.id || null;
  if (!bankId) {
    const [[byName]] = await conn.execute(
      `SELECT id FROM banks WHERE LOWER(TRIM(name)) = LOWER(TRIM(:name)) LIMIT 1`,
      { name },
    );
    bankId = byName?.id || null;
  }

  if (bankId) {
    await conn.execute(
      `UPDATE banks SET
         name = :name,
         bank_type = :bank_type,
         status = :status,
         display_priority = :priority,
         lender_code = :lender_code,
         effective_from = COALESCE(:effective_from, effective_from),
         policy_source = COALESCE(:policy_source, policy_source),
         updated_at = NOW()
       WHERE id = :id`,
      {
        id: bankId,
        name,
        bank_type: bankType,
        status,
        priority,
        lender_code: lenderCode,
        effective_from: effectiveFrom,
        policy_source: policySource,
      },
    );
    idMap.lenders[row.Lender_ID] = { bankId, action: 'updated' };
    return { bankId, action: 'updated' };
  }

  bankId = newId();
  await conn.execute(
    `INSERT INTO banks (
       id, name, bank_type, status, display_priority, lender_code,
       effective_from, policy_source, created_by
     ) VALUES (
       :id, :name, :bank_type, :status, :priority, :lender_code,
       :effective_from, :policy_source, :created_by
     )`,
    {
      id: bankId,
      name,
      bank_type: bankType,
      status,
      priority,
      lender_code: lenderCode,
      effective_from: effectiveFrom,
      policy_source: policySource,
      created_by: createdBy || null,
    },
  );
  idMap.lenders[row.Lender_ID] = { bankId, action: 'created' };
  return { bankId, action: 'created' };
}

async function upsertProduct(conn, row, idMap) {
  const lenderRef = idMap.lenders[row.Lender_ID];
  if (!lenderRef?.bankId) {
    return { action: 'skipped', reason: 'missing_lender' };
  }
  const bankId = lenderRef.bankId;
  const productCode = String(row.Product_Code || '').trim().toUpperCase();
  const name = String(row.Product_Name || '').trim();
  const cat = mapProductCategory(row.Product_Category);
  const isActive = statusActive(row.Status);

  const [existingRows] = await conn.execute(
    `SELECT id, data FROM bank_products WHERE bank_id = :bankId`,
    { bankId },
  );
  const match = existingRows.find((r) => {
    const d = parseProductData(r.data);
    const code = String(d.product_code || d.productCode || '').toUpperCase();
    const extId = String(d.external_product_id || d.Product_ID || '');
    return code === productCode || extId === String(row.Product_ID);
  });

  const feesForProduct = idMap.feesByProduct?.[String(row.Product_ID || '').trim()] || [];
  const processingFeeRow =
    feesForProduct.find((f) =>
      String(f.Fee_Type || f.fee_type || '')
        .toLowerCase()
        .includes('processing'),
    ) || null;
  const feeMethod = String(
    processingFeeRow?.Calculation_Method || processingFeeRow?.calculation_method || '',
  )
    .trim()
    .toUpperCase();
  const feeValue = toNumber(processingFeeRow?.Value ?? processingFeeRow?.value);
  const isPctFee =
    feeMethod === 'PERCENTAGE'
    || feeMethod === 'PERCENT'
    || feeMethod === 'PCT'
    || feeMethod.includes('PERCENT');
  const isFixedFee =
    feeMethod === 'FIXED'
    || feeMethod === 'FLAT'
    || feeMethod === 'AMOUNT'
    || feeMethod.includes('FIXED')
    || feeMethod.includes('FLAT');

  let processingFeePercentage = undefined;
  let processingFeeFixed = undefined;
  let processingFee = undefined;

  // Prefer Products-sheet fee columns (classic form fields); fall back to Fees sheet.
  const sheetPct = toNumber(
    firstPresent(row, 'Processing_Fee_Percentage', 'Processing_Fee_Pct', 'processing_fee_percentage'),
  );
  const sheetFixed = toNumber(
    firstPresent(row, 'Processing_Fee_Fixed', 'Processing_Fee_Amount', 'processing_fee_fixed'),
  );
  if (sheetPct != null) {
    processingFeePercentage = sheetPct;
    processingFee = `${sheetPct}%`;
  }
  if (sheetFixed != null) {
    processingFeeFixed = sheetFixed;
    if (processingFeePercentage == null) processingFee = `₹${sheetFixed}`;
  }

  if (processingFeePercentage == null && processingFeeFixed == null && processingFeeRow && feeValue != null) {
    if (isPctFee) {
      processingFeePercentage = feeValue;
      processingFee = `${feeValue}%`;
    } else if (isFixedFee || feeMethod) {
      processingFeeFixed = feeValue;
      processingFee = `₹${feeValue}`;
    } else {
      processingFeePercentage = feeValue;
      processingFee = `${feeValue}%`;
    }
  }

  const obligation = (idMap.obligationsByProduct?.[String(row.Product_ID || '').trim()] || [])[0];

  const minLoan = toNumber(firstPresent(row, 'Minimum_Loan_Amount', 'Min_Loan_Amount', 'min_loan_amount'));
  const maxLoan = toNumber(firstPresent(row, 'Maximum_Loan_Amount', 'Max_Loan_Amount', 'max_loan_amount'));
  const minTenureMonths = toNumber(
    firstPresent(row, 'Minimum_Tenure_Months', 'Min_Tenure_Months', 'min_tenure_months'),
  );
  const maxTenureMonths = toNumber(
    firstPresent(row, 'Maximum_Tenure_Months', 'Max_Tenure_Months', 'max_tenure_months'),
  );
  let minTenureYears = toNumber(
    firstPresent(row, 'Minimum_Tenure_Years', 'Min_Tenure_Years', 'min_tenure_years'),
  );
  let maxTenureYears = toNumber(
    firstPresent(row, 'Maximum_Tenure_Years', 'Max_Tenure_Years', 'max_tenure_years'),
  );
  if (minTenureYears == null && minTenureMonths != null) {
    minTenureYears = Math.round((minTenureMonths / 12) * 100) / 100;
  }
  if (maxTenureYears == null && maxTenureMonths != null) {
    maxTenureYears = Math.round((maxTenureMonths / 12) * 100) / 100;
  }
  const resolvedMinMonths =
    minTenureMonths != null
      ? minTenureMonths
      : minTenureYears != null
        ? Math.round(minTenureYears * 12)
        : null;
  const resolvedMaxMonths =
    maxTenureMonths != null
      ? maxTenureMonths
      : maxTenureYears != null
        ? Math.round(maxTenureYears * 12)
        : null;

  const rateFrom = toNumber(firstPresent(row, 'Interest_Rate_From', 'Interest_Rate_Min', 'interest_rate_min'));
  const rateTo = toNumber(firstPresent(row, 'Interest_Rate_To', 'Interest_Rate_Max', 'interest_rate_max'));

  const nextData = {
    ...(match ? parseProductData(match.data) : {}),
    product_code: productCode,
    external_product_id: row.Product_ID,
    product_category_slug: cat.slug,
    loan_type: cat.loanType,
    policy_pack_source: 'lender_policy_bulk_upload',
  };

  assignText(nextData, 'product_type', firstPresent(row, 'Product_Type', 'product_type'));
  assignText(nextData, 'target_customer', firstPresent(row, 'Target_Customer', 'target_customer'));
  assignText(nextData, 'purpose', firstPresent(row, 'Purpose', 'purpose'));
  assignText(nextData, 'policy_version', firstPresent(row, 'Policy_Version', 'policy_version'));
  assignText(nextData, 'apply_url', firstPresent(row, 'Apply_URL', 'Direct_Apply_Link', 'apply_url', 'Apply_Link'));

  if (minLoan != null) {
    nextData.min_loan_amount = minLoan;
    nextData.minAmount = minLoan;
  }
  if (maxLoan != null) {
    nextData.max_loan_amount = maxLoan;
    nextData.maxAmount = maxLoan;
  }
  if (resolvedMinMonths != null) {
    nextData.min_tenure_months = resolvedMinMonths;
    nextData.minTenure = `${resolvedMinMonths} months`;
  }
  if (resolvedMaxMonths != null) {
    nextData.max_tenure_months = resolvedMaxMonths;
    nextData.maxTenure = `${resolvedMaxMonths} months`;
  }
  if (minTenureYears != null) nextData.min_tenure_years = minTenureYears;
  if (maxTenureYears != null) nextData.max_tenure_years = maxTenureYears;

  if (rateFrom != null) nextData.interest_rate_min = rateFrom;
  if (rateTo != null) nextData.interest_rate_max = rateTo;
  if (rateFrom != null || rateTo != null) {
    nextData.interestRate = `${rateFrom ?? ''}%-${rateTo ?? ''}%`.replace(/%-%/, '% - ');
    if (rateFrom != null && rateTo != null) {
      nextData.interestRate = `${rateFrom}% - ${rateTo}%`;
    } else if (rateFrom != null) {
      nextData.interestRate = `${rateFrom}%`;
    } else {
      nextData.interestRate = `${rateTo}%`;
    }
  }

  if (processingFeePercentage != null) {
    nextData.processing_fee_percentage = processingFeePercentage;
    nextData.processingFeePercentage = processingFeePercentage;
  }
  if (processingFeeFixed != null) {
    nextData.processing_fee_fixed = processingFeeFixed;
    nextData.processingFeeFixed = processingFeeFixed;
  }
  if (processingFee != null) nextData.processingFee = processingFee;

  assignText(nextData, 'other_charges', firstPresent(row, 'Other_Charges', 'other_charges'));
  assignText(nextData, 'prepayment_charges', firstPresent(row, 'Prepayment_Charges', 'prepayment_charges'));
  assignText(nextData, 'foreclosure_charges', firstPresent(row, 'Foreclosure_Charges', 'foreclosure_charges'));
  assignNumber(
    nextData,
    'foreclosure_fee_pct',
    firstPresent(row, 'Foreclosure_Fee_Pct', 'Foreclosure_Fee_Percentage', 'foreclosure_fee_pct'),
  );
  assignNumber(
    nextData,
    'foreclosure_allowed_after_months',
    firstPresent(
      row,
      'Foreclosure_Allowed_After_Months',
      'Foreclosure_After_Months',
      'foreclosure_allowed_after_months',
    ),
  );
  assignNumber(
    nextData,
    'part_payment_fee_pct',
    firstPresent(row, 'Part_Payment_Fee_Pct', 'Part_Payment_Fee_Percentage', 'part_payment_fee_pct'),
  );
  assignNumber(
    nextData,
    'bouncing_charges',
    firstPresent(row, 'Bouncing_Charges', 'Bounce_Charges', 'bouncing_charges'),
  );
  assignNumber(
    nextData,
    'late_fee_pct',
    firstPresent(row, 'Late_Fee_Pct', 'Late_Fee_Percentage', 'late_fee_pct'),
  );
  assignNumber(
    nextData,
    'late_payment_fee_fixed',
    firstPresent(row, 'Late_Payment_Fee_Fixed', 'Late_Fee_Fixed', 'late_payment_fee_fixed'),
  );
  assignText(
    nextData,
    'late_payment_charges',
    firstPresent(row, 'Late_Payment_Charges', 'late_payment_charges'),
  );
  assignText(
    nextData,
    'documentation_charges',
    firstPresent(row, 'Documentation_Charges', 'documentation_charges'),
  );
  assignText(
    nextData,
    'disbursal_timeline',
    firstPresent(row, 'Disbursal_Timeline', 'disbursal_timeline'),
  );
  assignText(
    nextData,
    'collateral_required',
    firstPresent(row, 'Collateral_Required', 'collateral_required'),
  );

  // Multi-line marketplace lists — one item per line in Excel (Alt+Enter) OR separated by |
  const splitList = (raw) => {
    if (raw == null || String(raw).trim() === '') return null;
    return String(raw)
      .split(/\r?\n|\|/)
      .map((s) => s.trim())
      .filter(Boolean);
  };
  const features = splitList(
    firstPresent(row, 'Features', 'Key_Features', 'features', 'key_features'),
  );
  if (features) nextData.features = features;
  const eligibility = splitList(
    firstPresent(
      row,
      'Eligibility_Criteria',
      'Eligibility',
      'eligibility_criteria',
      'eligibility',
    ),
  );
  if (eligibility) nextData.eligibility_criteria = eligibility;
  const policies = splitList(
    firstPresent(row, 'Policies', 'Policies_Terms', 'policies', 'policies_terms'),
  );
  if (policies) nextData.policies = policies;
  const docsRequired = splitList(
    firstPresent(
      row,
      'Documentation_Required',
      'Documents_Required',
      'documentation_required',
      'documentationRequired',
    ),
  );
  if (docsRequired) nextData.documentation_required = docsRequired;

  if (obligation) {
    const foir = toNumber(obligation.Maximum_FOIR_Percentage);
    if (foir != null) nextData.maximum_foir_percentage = foir;
  }

  if (match) {
    await conn.execute(
      `UPDATE bank_products SET name = :name, is_active = :active, data = :data, updated_at = NOW()
       WHERE id = :id`,
      {
        id: match.id,
        name,
        active: isActive,
        data: JSON.stringify(nextData),
      },
    );
    idMap.products[row.Product_ID] = {
      productId: match.id,
      bankId,
      action: 'updated',
      category: cat,
      data: nextData,
    };
    return { productId: match.id, action: 'updated' };
  }

  const productId = newId();
  await conn.execute(
    `INSERT INTO bank_products (id, bank_id, name, is_active, data)
     VALUES (:id, :bank_id, :name, :active, :data)`,
    {
      id: productId,
      bank_id: bankId,
      name,
      active: isActive,
      data: JSON.stringify(nextData),
    },
  );
  idMap.products[row.Product_ID] = {
    productId,
    bankId,
    action: 'created',
    category: cat,
    data: nextData,
  };
  return { productId, action: 'created' };
}

async function upsertPricingRules(conn, sheets, idMap, result) {
  const rows = sheets.Pricing_Rules || [];
  for (const row of rows) {
    const product = idMap.products[row.Product_ID];
    if (!product) {
      result.pricingSkipped += 1;
      continue;
    }
    const rate = toNumber(row.Interest_Rate_From) ?? toNumber(row.Interest_Rate_To);
    if (rate == null) {
      result.pricingSkipped += 1;
      continue;
    }
    const productType = product.data?.product_category_slug || product.category?.slug || 'home_loan';
    const loanType = product.category?.loanType || 'home_loan';
    const scoreMin = toNumber(row.Minimum_CIBIL, 0) || 0;
    const scoreMax = toNumber(row.Maximum_CIBIL, 900) || 900;
    const amountMin = toNumber(product.data?.min_loan_amount, 0) || 0;
    const amountMax = toNumber(product.data?.max_loan_amount, 0) || 0;
    const termMin = toNumber(product.data?.min_tenure_months, 0) || 0;
    const termMax = toNumber(product.data?.max_tenure_months, 0) || 0;

    await conn.execute(
      `INSERT INTO interest_matrix_rates (
         id, bank_id, product_type, loan_type,
         credit_score_min, credit_score_max,
         loan_amount_min, loan_amount_max,
         term_min, term_max, interest_rate, status, change_note
       ) VALUES (
         :id, :bank_id, :product_type, :loan_type,
         :score_min, :score_max,
         :amount_min, :amount_max,
         :term_min, :term_max, :rate, 'active', :note
       )`,
      {
        id: newId(),
        bank_id: product.bankId,
        product_type: productType,
        loan_type: loanType,
        score_min: scoreMin,
        score_max: scoreMax,
        amount_min: amountMin,
        amount_max: amountMax,
        term_min: termMin,
        term_max: termMax,
        rate,
        note: `Bulk import ${row.Rule_ID || ''} risk ${row.Risk_Grade || ''}`.trim(),
      },
    );
    result.pricingImported += 1;
  }
}

async function upsertDocumentRules(conn, sheets, idMap, result) {
  const rows = sheets.Document_Rules || [];
  const byProduct = {};
  for (const row of rows) {
    if (!row.Product_ID) continue;
    if (!byProduct[row.Product_ID]) byProduct[row.Product_ID] = [];
    byProduct[row.Product_ID].push(row);
  }

  for (const [productKey, docRows] of Object.entries(byProduct)) {
    const product = idMap.products[productKey];
    if (!product) {
      result.documentsSkipped += 1;
      continue;
    }
    const productType = product.data?.product_category_slug || product.category?.slug || 'home_loan';
    const loanType = product.category?.loanType || 'home_loan';

    await conn.execute(
      `DELETE FROM document_requirements
       WHERE bank_id = :bank_id
         AND LOWER(COALESCE(product_type, '')) = LOWER(:product_type)
         AND LOWER(COALESCE(loan_type, '')) = LOWER(:loan_type)`,
      {
        bank_id: product.bankId,
        product_type: productType,
        loan_type: loanType,
      },
    );

    let sortOrder = 0;
    for (const doc of docRows) {
      const title = String(doc.Document_Name || doc.Document_Code || '').trim();
      if (!title) continue;
      const isPhoto = /photo/i.test(title);
      const allowed = isPhoto ? ['jpeg', 'png', 'webp'] : ['jpeg', 'png', 'pdf'];
      const required = String(doc.Requirement_Status || 'MANDATORY').toUpperCase() !== 'OPTIONAL';
      const docType = String(doc.Document_Code || title)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 120) || 'document';

      await conn.execute(
        `INSERT INTO document_requirements (
           id, bank_id, product_type, loan_type, document_type, title, subtitle,
           allowed_file_types_json, is_required, sort_order, is_active
         ) VALUES (
           :id, :bank_id, :product_type, :loan_type, :document_type, :title, :subtitle,
           :allowed_file_types_json, :is_required, :sort_order, TRUE
         )`,
        {
          id: newId(),
          bank_id: product.bankId,
          product_type: productType,
          loan_type: loanType,
          document_type: docType,
          title,
          subtitle: doc.Verification_Method
            ? `Verify: ${doc.Verification_Method}${doc.Conditional_Condition ? ` | ${doc.Conditional_Condition}` : ''}`
            : null,
          allowed_file_types_json: JSON.stringify(allowed),
          is_required: required,
          sort_order: sortOrder,
        },
      );
      sortOrder += 1;
      result.documentsCreated += 1;
    }
    result.documentsUpdated += 1;
  }
}

function inferFieldFromRuleRow(row) {
  const candidates = [
    ['Minimum_Age', 'age', '>='],
    ['Maximum_Age', 'age', '<='],
    ['Minimum_CIBIL', 'credit_score', '>='],
    ['Maximum_CIBIL', 'credit_score', '<='],
    ['Minimum_Income', 'monthly_income', '>='],
    ['Minimum_Annual_Income', 'annual_income', '>='],
    ['Minimum_Years_Employed', 'years_employed', '>='],
  ];
  for (const [col, field, op] of candidates) {
    if (row[col] != null && row[col] !== '') {
      return { fieldKey: field, operator: op, value: toNumber(row[col]) ?? row[col] };
    }
  }
  if (row.Field_Name || row.Attribute) {
    return {
      fieldKey: String(row.Field_Name || row.Attribute)
        .toLowerCase()
        .replace(/\s+/g, '_'),
      operator: String(row.Operator || '>=').toUpperCase(),
      value: row.Value ?? row.Min_Value ?? null,
      valueTo: row.Max_Value ?? null,
    };
  }
  return null;
}

function indexRowsByProductId(rows = []) {
  const map = {};
  for (const row of rows) {
    const pid = String(row?.Product_ID ?? row?.product_id ?? '').trim();
    if (!pid) continue;
    if (!map[pid]) map[pid] = [];
    map[pid].push(row);
  }
  return map;
}

function firstRow(map, productId) {
  const list = map[String(productId || '').trim()] || [];
  return list[0] || null;
}

/** Convert FOIR percent (55) or ratio (0.55) to 0–1 decimal for approval matrix. */
function normalizeFoir(raw) {
  const n = toNumber(raw);
  if (n == null) return null;
  if (n > 1) return Math.round((n / 100) * 10000) / 10000;
  return n;
}

/** Prefer annual income; treat small Minimum_Income values as monthly × 12. */
function resolveAnnualIncome(incomeRow) {
  if (!incomeRow) return { min: null, max: null };
  const annualMin = toNumber(
    firstPresent(incomeRow, 'Minimum_Annual_Income', 'Min_Annual_Income', 'minimum_annual_income'),
  );
  const annualMax = toNumber(
    firstPresent(incomeRow, 'Maximum_Annual_Income', 'Max_Annual_Income', 'maximum_annual_income'),
  );
  let min = annualMin;
  let max = annualMax;
  const monthlyMin = toNumber(
    firstPresent(incomeRow, 'Minimum_Income', 'Min_Income', 'Minimum_Monthly_Income'),
  );
  const monthlyMax = toNumber(
    firstPresent(incomeRow, 'Maximum_Income', 'Max_Income', 'Maximum_Monthly_Income'),
  );
  if (min == null && monthlyMin != null) {
    min = monthlyMin < 100000 ? monthlyMin * 12 : monthlyMin;
  }
  if (max == null && monthlyMax != null) {
    max = monthlyMax < 100000 ? monthlyMax * 12 : monthlyMax;
  }
  return { min, max };
}

/**
 * Upsert Bank Approval Matrix rules from Products + Applicant/Income/Credit/Obligation/LTV sheets.
 * One rule per Product_ID (keyed by bank + external_product_id in data, fallback rule_name).
 */
async function upsertApprovalMatrixFromSheets(conn, sheets, idMap, result) {
  result.approvalRulesCreated = 0;
  result.approvalRulesUpdated = 0;
  result.approvalRulesSkipped = 0;

  const products = sheets.Products || [];
  if (!products.length) return;

  const applicantBy = indexRowsByProductId(sheets.Applicant_Rules);
  const incomeBy = indexRowsByProductId(sheets.Income_Rules);
  const creditBy = indexRowsByProductId(sheets.Credit_Rules);
  const obligationBy = indexRowsByProductId(sheets.Obligation_Rules);
  const tenureBy = indexRowsByProductId(sheets.Tenure_Rules);
  const ltvBy = indexRowsByProductId(sheets.LTV_Rules);

  let priority = products.length;
  for (const row of products) {
    const productId = String(row.Product_ID || '').trim();
    const product = idMap.products[productId];
    if (!product?.bankId) {
      result.approvalRulesSkipped += 1;
      continue;
    }

    const productCode = String(row.Product_Code || product.data?.product_code || productId).trim();
    const productName = String(row.Product_Name || product.data?.product_name || productCode).trim();
    const ruleName = `${productCode} — ${productName}`.slice(0, 200);
    const loanType =
      product.category?.loanType
      || product.data?.loan_type
      || mapProductCategory(row.Product_Category).loanType
      || 'personal_loan';

    const applicant = firstRow(applicantBy, productId);
    const income = firstRow(incomeBy, productId);
    const credit = firstRow(creditBy, productId);
    const obligation = firstRow(obligationBy, productId);
    const tenure = firstRow(tenureBy, productId);
    const ltv = firstRow(ltvBy, productId);
    const { min: minAnnual, max: maxAnnual } = resolveAnnualIncome(income);

    const minAge = toNumber(firstPresent(applicant, 'Minimum_Age', 'Min_Age', 'minimum_age'));
    const maxAge = toNumber(firstPresent(applicant, 'Maximum_Age', 'Max_Age', 'maximum_age'));
    const minCibil = toNumber(firstPresent(credit, 'Minimum_CIBIL', 'Min_CIBIL', 'minimum_cibil'));
    const maxCibil = toNumber(firstPresent(credit, 'Maximum_CIBIL', 'Max_CIBIL', 'maximum_cibil'));
    const foir = normalizeFoir(
      firstPresent(
        obligation,
        'Maximum_FOIR_Percentage',
        'Max_FOIR_Percentage',
        'FOIR',
        'foir_unsecured',
      ),
    );
    const tenureMonths =
      toNumber(firstPresent(tenure, 'Maximum_Tenure_Months', 'Max_Tenure_Months'))
      ?? toNumber(product.data?.max_tenure_months)
      ?? toNumber(row.Maximum_Tenure_Months);
    const ltvRatio = toNumber(firstPresent(ltv, 'Maximum_LTV', 'Max_LTV', 'max_ltv'));

    const targetCustomer = String(row.Target_Customer || product.data?.target_customer || '').toLowerCase();
    const employmentTypes = [];
    if (/salaried/.test(targetCustomer)) employmentTypes.push('salaried');
    if (/self|business|professional/.test(targetCustomer)) {
      employmentTypes.push('self_employed');
    }
    if (!employmentTypes.length && targetCustomer) {
      employmentTypes.push(targetCustomer.replace(/\s+/g, '_'));
    }

    const data = {
      loan_type: loanType,
      min_annual_income: minAnnual,
      max_annual_income: maxAnnual,
      min_credit_score: minCibil,
      max_credit_score: maxCibil,
      employment_types: employmentTypes,
      eligible_states: [],
      eligible_cities: [],
      min_loan_amount:
        toNumber(row.Minimum_Loan_Amount) ?? toNumber(product.data?.min_loan_amount) ?? null,
      max_loan_amount:
        toNumber(row.Maximum_Loan_Amount) ?? toNumber(product.data?.max_loan_amount) ?? null,
      min_age: minAge,
      max_age: maxAge,
      foir_unsecured: foir,
      foir_secured: foir,
      tenure_unsecured_months: tenureMonths,
      tenure_secured_months: tenureMonths,
      ltv_ratio: ltvRatio,
      external_product_id: productId,
      product_code: productCode,
      source: 'lender_policy_bulk_upload',
    };

    const isActive = statusActive(row.Status);
    const approvalProbability = toNumber(
      firstPresent(row, 'Approval_Probability', 'approval_probability'),
      75,
    ) || 75;

    // Match existing rule by external_product_id in data, else by bank + rule_name.
    const [existingRows] = await conn.execute(
      `SELECT id, rule_name, data FROM approval_matrix_rules WHERE bank_id = :bankId`,
      { bankId: product.bankId },
    );
    const match = (existingRows || []).find((r) => {
      const d = parseProductData(r.data);
      if (String(d.external_product_id || '') === productId) return true;
      if (String(d.product_code || '').toUpperCase() === productCode.toUpperCase()) return true;
      return String(r.rule_name || '') === ruleName;
    });

    if (match) {
      const prev = parseProductData(match.data);
      const merged = { ...prev };
      for (const [k, v] of Object.entries(data)) {
        if (v == null) continue;
        if (Array.isArray(v) && v.length === 0) continue;
        merged[k] = v;
      }
      merged.external_product_id = productId;
      merged.product_code = productCode;
      merged.loan_type = loanType;
      merged.source = 'lender_policy_bulk_upload';
      await conn.execute(
        `UPDATE approval_matrix_rules SET
           rule_name = :rule_name,
           priority = :priority,
           is_active = :is_active,
           approval_probability = :approval_probability,
           data = :data,
           updated_at = NOW()
         WHERE id = :id`,
        {
          id: match.id,
          rule_name: ruleName,
          priority,
          is_active: isActive,
          approval_probability: approvalProbability,
          data: JSON.stringify(merged),
        },
      );
      result.approvalRulesUpdated += 1;
    } else {
      await conn.execute(
        `INSERT INTO approval_matrix_rules (
           id, bank_id, rule_name, priority, is_active, approval_probability, data
         ) VALUES (
           :id, :bank_id, :rule_name, :priority, :is_active, :approval_probability, :data
         )`,
        {
          id: newId(),
          bank_id: product.bankId,
          rule_name: ruleName,
          priority,
          is_active: isActive,
          approval_probability: approvalProbability,
          data: JSON.stringify(data),
        },
      );
      result.approvalRulesCreated += 1;
    }
    priority -= 1;
  }
}

async function upsertPolicyPackFromSheets(conn, sheets, idMap, result, committedBy) {
  await ensurePolicyConsoleSchema();
  result.versionsCreated = 0;
  result.rulesCreated = 0;
  result.ltvCreated = 0;
  result.riskCreated = 0;
  result.matchingUpdated = false;

  const versionByProduct = {};

  for (const row of sheets.Policy_Versions || []) {
    const product = idMap.products[row.Product_ID];
    if (!product) continue;
    const versionId = await createDraftVersion({
      bankId: product.bankId,
      bankProductId: product.productId,
      externalProductId: row.Product_ID,
      versionLabel: String(row.Version_Label || row.Policy_Version || 'v1'),
      changeReason: row.Change_Reason || 'Bulk import Policy_Versions',
      effectiveFrom: row.Effective_From || null,
      effectiveTo: row.Effective_To || null,
      snapshot: product.data,
      actorId: committedBy,
      conn,
    });
    versionByProduct[row.Product_ID] = versionId;
    result.versionsCreated += 1;
  }

  const ruleSheets = [
    ['Applicant_Rules', 'applicant'],
    ['Income_Rules', 'income'],
    ['Employment_Rules', 'employment'],
    ['Business_Rules', 'business'],
    ['Credit_Rules', 'credit'],
    ['Banking_Rules', 'banking'],
  ];
  for (const [sheetName] of ruleSheets) {
    for (const row of sheets[sheetName] || []) {
      if (!row.Product_ID || versionByProduct[row.Product_ID]) continue;
      const product = idMap.products[row.Product_ID];
      if (!product) continue;
      versionByProduct[row.Product_ID] = await createDraftVersion({
        bankId: product.bankId,
        bankProductId: product.productId,
        externalProductId: row.Product_ID,
        versionLabel: String(product.data?.policy_version || 'bulk-v1'),
        changeReason: `Auto draft from ${sheetName}`,
        snapshot: product.data,
        actorId: committedBy,
        conn,
      });
      result.versionsCreated += 1;
    }
  }

  for (const [sheetName, domain] of ruleSheets) {
    for (const row of sheets[sheetName] || []) {
      const product = idMap.products[row.Product_ID];
      if (!product) continue;
      const versionId = versionByProduct[row.Product_ID] || null;
      const cond = inferFieldFromRuleRow(row);
      const conditions = cond ? [cond] : [];
      await createEligibilityRule({
        versionId,
        bankId: product.bankId,
        bankProductId: product.productId,
        ruleDomain: domain,
        ruleCode: row.Rule_ID || row.Rule_Code || null,
        ruleName: row.Rule_Name || row.Description || `${domain} rule`,
        severity: String(row.Severity || 'soft').toLowerCase() === 'critical' ? 'critical' : 'soft',
        sourceSheet: sheetName,
        sourceRow: row,
        conditions,
        conn,
      });
      result.rulesCreated += 1;
    }
  }

  for (const row of sheets.LTV_Rules || []) {
    const product = idMap.products[row.Product_ID];
    if (!product) continue;
    await conn.execute(
      `INSERT INTO property_ltv_rules (
         id, version_id, bank_id, bank_product_id, property_type, max_ltv,
         min_amount, max_amount, applicant_type, data_json
       ) VALUES (
         :id, :version_id, :bank_id, :bank_product_id, :property_type, :max_ltv,
         :min_amount, :max_amount, :applicant_type, :data_json
       )`,
      {
        id: newId(),
        version_id: versionByProduct[row.Product_ID] || null,
        bank_id: product.bankId,
        bank_product_id: product.productId,
        property_type: row.Property_Type || 'residential',
        max_ltv: toNumber(row.Maximum_LTV ?? row.Max_LTV, 0.75) || 0.75,
        min_amount: toNumber(row.Minimum_Amount),
        max_amount: toNumber(row.Maximum_Amount),
        applicant_type: row.Applicant_Type || null,
        data_json: JSON.stringify(row),
      },
    );
    result.ltvCreated += 1;
  }

  const exceptionSet = new Set(sheets.Exceptions || []);
  for (const row of [...(sheets.Risk_Rules || []), ...(sheets.Exceptions || [])]) {
    const product = idMap.products[row.Product_ID];
    if (!product) continue;
    await conn.execute(
      `INSERT INTO risk_exception_rules (
         id, version_id, bank_id, bank_product_id, rule_type, rule_code,
         description, severity, condition_json
       ) VALUES (
         :id, :version_id, :bank_id, :bank_product_id, :rule_type, :rule_code,
         :description, :severity, :condition_json
       )`,
      {
        id: newId(),
        version_id: versionByProduct[row.Product_ID] || null,
        bank_id: product.bankId,
        bank_product_id: product.productId,
        rule_type: exceptionSet.has(row) || row.Exception_ID ? 'exception' : 'risk',
        rule_code: row.Rule_ID || row.Exception_ID || null,
        description: row.Description || row.Rule_Name || 'Imported risk/exception',
        severity: String(row.Severity || 'soft').toLowerCase() === 'critical' ? 'critical' : 'soft',
        condition_json: JSON.stringify(row),
      },
    );
    result.riskCreated += 1;
  }

  const matchingRows = sheets.Matching_Rules || [];
  if (matchingRows.length) {
    const weights = {};
    for (const row of matchingRows) {
      const key = String(row.Weight_Key || row.Factor || row.Rule_Name || '')
        .toLowerCase()
        .replace(/\s+/g, '_');
      const val = toNumber(row.Weight || row.Penalty || row.Value);
      if (key && val != null) weights[key] = val;
    }
    if (Object.keys(weights).length) {
      await saveMatchingConfig({ weights, actorId: committedBy });
      result.matchingUpdated = true;
      await writePolicyAudit({
        action: 'matching_weights_bulk_import',
        newValue: weights,
        changeReason: 'Matching_Rules sheet',
        actorId: committedBy,
        conn,
      });
    }
  }
}

export async function commitImportJob(jobId, committedBy) {
  const pool = getPool();
  await ensureImportSchema(pool);
  const job = await getImportJob(jobId);
  if (!job) {
    const e = new Error('Import job not found');
    e.status = 404;
    throw e;
  }
  if (job.status === 'invalid') {
    const e = new Error('Cannot commit an invalid import. Fix errors and re-validate.');
    e.status = 400;
    throw e;
  }

  const sheets =
    typeof job.sheet_payload_json === 'string'
      ? JSON.parse(job.sheet_payload_json)
      : job.sheet_payload_json || {};

  const prevResult =
    typeof job.commit_result_json === 'string'
      ? (() => {
        try {
          return JSON.parse(job.commit_result_json);
        } catch {
          return null;
        }
      })()
      : job.commit_result_json;

  const hasGeoRows =
    (sheets.Geo_Coverage || []).length > 0 || (sheets.Location_Rules || []).length > 0;

  // Idempotent: already committed AND geo finished (or no geo) → return cached result.
  // If committed but geo never finished (timeout / crash / prior geoError), retry geo only.
  if (job.status === 'committed' && prevResult) {
    const geoSucceeded =
      Boolean(prevResult.geoVersionId)
      || prevResult.geoStatus === 'skipped'
      || prevResult.geoStatus === 'pending_approval'
      || !hasGeoRows;
    if (geoSucceeded) {
      return { ...prevResult, alreadyCommitted: true };
    }
  }

  const idMap = {
    lenders: {},
    products: {},
    feesByProduct: {},
    obligationsByProduct: {},
  };
  for (const fee of sheets.Fees || []) {
    const pid = String(fee.Product_ID ?? fee.product_id ?? '').trim();
    if (!pid) continue;
    if (!idMap.feesByProduct[pid]) idMap.feesByProduct[pid] = [];
    idMap.feesByProduct[pid].push(fee);
  }
  for (const ob of sheets.Obligation_Rules || []) {
    const pid = String(ob.Product_ID ?? ob.product_id ?? '').trim();
    if (!pid) continue;
    if (!idMap.obligationsByProduct[pid]) idMap.obligationsByProduct[pid] = [];
    idMap.obligationsByProduct[pid].push(ob);
  }

  const result = {
    lendersCreated: 0,
    lendersUpdated: 0,
    productsCreated: 0,
    productsUpdated: 0,
    pricingImported: 0,
    pricingSkipped: 0,
    documentsCreated: 0,
    documentsUpdated: 0,
    documentsSkipped: 0,
    unsupportedSheetsStored: (typeof job.unsupported_sheets_json === 'string'
      ? JSON.parse(job.unsupported_sheets_json)
      : job.unsupported_sheets_json) || [],
  };

  // ——— Phase 1: lenders + products only (hard fail) ———
  // Soft secondary sheets must NOT share this transaction: a PostgreSQL error aborts the
  // whole txn, so a caught pricing/policy error would still poison the final COMMIT UPDATE.
  if (job.status !== 'committed') {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      try {
        await conn.execute(`SET LOCAL statement_timeout = '120s'`);
      } catch {
        /* ignore if role cannot set timeout */
      }

      for (const row of sheets.Lenders || []) {
        try {
          const r = await upsertLender(conn, row, committedBy, idMap);
          if (r.action === 'created') result.lendersCreated += 1;
          if (r.action === 'updated') result.lendersUpdated += 1;
        } catch (err) {
          const code = String(row?.Lender_Code || row?.Lender_ID || '').trim() || 'unknown';
          const wrapped = new Error(
            `Lender "${code}" failed: ${err?.message || 'database error'}`,
          );
          wrapped.status = 400;
          wrapped.cause = err;
          throw wrapped;
        }
      }
      for (const row of sheets.Products || []) {
        try {
          const r = await upsertProduct(conn, row, idMap);
          if (r.action === 'created') result.productsCreated += 1;
          if (r.action === 'updated') result.productsUpdated += 1;
        } catch (err) {
          const code = String(row?.Product_Code || row?.Product_ID || '').trim() || 'unknown';
          const wrapped = new Error(
            `Product "${code}" failed: ${err?.message || 'database error'}`,
          );
          wrapped.status = 400;
          wrapped.cause = err;
          throw wrapped;
        }
      }

      await conn.commit();
    } catch (err) {
      try {
        await conn.rollback();
      } catch {
        /* ignore */
      }
      const wrapped = new Error(
        err?.message
          ? `Publish failed while saving lenders/products: ${err.message}`
          : 'Publish failed while saving lenders/products',
      );
      wrapped.status = err?.status || 500;
      wrapped.cause = err;
      throw wrapped;
    } finally {
      conn.release();
    }

    // ——— Phase 2: soft dual-writes (own short transactions; never roll back lenders/products) ———
    const softConn = await pool.getConnection();
    try {
      try {
        await softConn.beginTransaction();
        await upsertPricingRules(softConn, sheets, idMap, result);
        await softConn.commit();
      } catch (err) {
        try {
          await softConn.rollback();
        } catch {
          /* ignore */
        }
        result.pricingError = err.message;
        console.warn('[lender-policy-import:pricing]', err?.message || err);
      }

      try {
        await softConn.beginTransaction();
        await upsertDocumentRules(softConn, sheets, idMap, result);
        await softConn.commit();
      } catch (err) {
        try {
          await softConn.rollback();
        } catch {
          /* ignore */
        }
        result.documentsError = err.message;
        console.warn('[lender-policy-import:documents]', err?.message || err);
      }

      try {
        await softConn.beginTransaction();
        await upsertApprovalMatrixFromSheets(softConn, sheets, idMap, result);
        await softConn.commit();
      } catch (err) {
        try {
          await softConn.rollback();
        } catch {
          /* ignore */
        }
        result.approvalMatrixError = err.message;
        console.warn('[lender-policy-import:approval-matrix]', err?.message || err);
      }

      try {
        await softConn.beginTransaction();
        await upsertPolicyPackFromSheets(softConn, sheets, idMap, result, committedBy);
        await softConn.commit();
      } catch (err) {
        try {
          await softConn.rollback();
        } catch {
          /* ignore */
        }
        result.policyPackError = err.message;
        console.warn('[lender-policy-import:policy-pack]', err?.message || err);
      }
    } finally {
      softConn.release();
    }

    // Mark committed before geo — large Location_Rules must not block / roll back core data.
    await pool.execute(
      `UPDATE lender_policy_import_jobs SET
         status = 'committed',
         commit_result_json = :result,
         committed_by = :by,
         committed_at = NOW(),
         updated_at = NOW()
       WHERE id = :id`,
      {
        id: jobId,
        result: JSON.stringify(result),
        by: committedBy || null,
      },
    );
  } else {
    // Rebuild idMap for geo retry from already-published lenders sheet.
    Object.assign(result, prevResult || {});
    const mapConn = await pool.getConnection();
    try {
      for (const row of sheets.Lenders || []) {
        await upsertLender(mapConn, row, committedBy, idMap);
      }
    } finally {
      mapConn.release();
    }
  }

  // ——— Phase 3: geo (Location_Rules / Geo_Coverage) ———
  try {
    await ensureLenderGeoPolicySchema(pool);
    const geoRows = [
      ...(sheets.Geo_Coverage || []),
      ...(sheets.Location_Rules || []).map((r) => ({
        Lender_Code: r.Lender_Code || r.Lender_ID,
        PIN_Code: r.PIN_Code || r.Serviceable_PIN || r.Pincode,
        Coverage_Type: r.Coverage_Type || r.Coverage || (r.Serviceable_PIN ? 'INCLUDE' : 'INCLUDE'),
        State: r.State,
        District: r.District,
        Tehsil: r.Tehsil,
        Remarks: r.Remarks || r.Rule_ID || null,
        Change_Reason: r.Change_Reason || 'Location_Rules import',
        Branch_Code: r.Branch_ID || r.Branch_Code,
        Radius_KM: r.Radius_KM,
      })),
    ];
    if (geoRows.length) {
      const lenderIdMap = {};
      for (const [key, val] of Object.entries(idMap.lenders || {})) {
        const bankId = typeof val === 'string' ? val : val?.bankId;
        if (!bankId) continue;
        lenderIdMap[key] = bankId;
        lenderIdMap[String(key).toUpperCase()] = bankId;
      }
      for (const row of sheets.Lenders || []) {
        const bankId = lenderIdMap[row.Lender_ID];
        if (bankId && row.Lender_Code) {
          lenderIdMap[row.Lender_Code] = bankId;
          lenderIdMap[String(row.Lender_Code).toUpperCase()] = bankId;
        }
      }
      const geo = await createGeoVersionFromSheetRows({
        rows: geoRows,
        uploadedBy: committedBy,
        sourceJobId: jobId,
        changeReason:
          geoRows.find((r) => r.Change_Reason)?.Change_Reason ||
          'Bulk upload Geo_Coverage / Location_Rules',
        effectiveFrom: geoRows.find((r) => r.Effective_From)?.Effective_From || null,
        effectiveTo: geoRows.find((r) => r.Effective_To)?.Effective_To || null,
        versionLabel: `bulk-geo-${jobId.slice(0, 8)}`,
        lenderIdMap,
      });
      result.geoVersionId = geo.versionId;
      result.geoRowsInserted = geo.inserted;
      result.geoRowsSkippedNoBank = geo.skippedNoBank || 0;
      result.geoStatus = geo.status;
      result.geoError = null;
      result.geoNote =
        'Geo version created as pending_approval — Super Admin must approve before live eligibility uses it.';
    } else {
      result.geoStatus = 'skipped';
    }
  } catch (err) {
    console.error('[lender-policy-import:geo]', err?.message || err);
    result.geoError = err.message;
    result.geoStatus = 'failed';
    result.geoNote =
      'Lenders/products/rules were published, but geo Location_Rules import failed. Click Publish import again to retry geo only, or fix lender codes under Lender geo policy.';
  }

  try {
    await pool.execute(
      `UPDATE lender_policy_import_jobs SET
         commit_result_json = :result,
         updated_at = NOW()
       WHERE id = :id`,
      { id: jobId, result: JSON.stringify(result) },
    );
  } catch (err) {
    console.warn('[lender-policy-import] could not update commit_result after geo:', err?.message);
  }

  return result;
}

export function buildPolicyTemplateWorkbook() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['Rfincare — Loan Advisory Lender Product Bulk Upload'],
      ['Workflow: Upload → Validate → Preview → Approve → Publish'],
      ['1. Fill Lenders and Products (required). Products sheet includes classic Product Edit fields (rates, fees, charges, tenure, disbursal) plus Features / Eligibility_Criteria / Policies / Documentation_Required (one item per line, or separate with | ).'],
      ['2. Optional: Pricing_Rules, Document_Rules, Fees, Obligation_Rules, Applicant/Income/Credit sheets. Publish also upserts Bank Approval Matrix (one rule per product) from Products + Applicant/Income/Credit/Obligation/Tenure/LTV.'],
      ['2b. Geo_Coverage (bank-level PIN/district INCLUDE|EXCLUDE|CONDITIONAL|BRANCH_DEPENDENT). Location_Rules also accepted.'],
      ['2c. After Publish, Super Admin must Approve geo version under Admin → Lender geo policy before live eligibility uses it.'],
      [`3. Operators on Rule_Conditions: ${ALLOWED_RULE_OPERATORS.join(', ')}`],
      ['4. Decision actions: PASS / REVIEW / FAIL'],
      ['5. Geo runs after FOIR/LTV/credit — not inside product rules.'],
    ]),
    'README',
  );
  for (const name of EXPECTED_SHEETS) {
    if (name === 'README') continue;
    const sample = SHEET_HEADER_SAMPLES[name] || [{ Note: 'Add rows matching the workbook contract' }];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sample), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** Build a downloadable CSV error/warning report for a saved preview. */
export function buildErrorReportCsv(errorReport) {
  const errors = errorReport?.errors || [];
  const warnings = errorReport?.warnings || [];
  const lines = ['Type,Sheet,Row,Message'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  for (const e of errors) {
    lines.push(['error', e.sheet, e.row ?? '', e.message].map(esc).join(','));
  }
  for (const w of warnings) {
    lines.push(['warning', w.sheet, w.row ?? '', w.message].map(esc).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function getTemplateBuffer() {
  const path = resolvePolicyTemplatePath();
  if (path) {
    try {
      return { buffer: readFileSync(path), path, generated: false };
    } catch (err) {
      // Fall through to generated workbook (e.g. unreadable mount in container).
      console.warn(`[lenderPolicyBulkImport] template read failed (${path}): ${err?.message || err}`);
    }
  }
  return { buffer: buildPolicyTemplateWorkbook(), path: null, generated: true };
}
