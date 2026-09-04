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
      Minimum_Loan_Amount: 500000,
      Maximum_Loan_Amount: 50000000,
      Minimum_Tenure_Months: 12,
      Maximum_Tenure_Months: 360,
      Interest_Rate_From: 8.5,
      Interest_Rate_To: 11.5,
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

  const feesForProduct = (idMap.feesByProduct?.[row.Product_ID] || [])[0];
  const processingFee =
    feesForProduct && String(feesForProduct.Fee_Type || '').toLowerCase().includes('processing')
      ? feesForProduct.Calculation_Method === 'PERCENTAGE'
        ? `${feesForProduct.Value}%`
        : `₹${feesForProduct.Value}`
      : undefined;

  const obligation = (idMap.obligationsByProduct?.[row.Product_ID] || [])[0];
  const nextData = {
    ...(match ? parseProductData(match.data) : {}),
    product_code: productCode,
    external_product_id: row.Product_ID,
    product_category_slug: cat.slug,
    loan_type: cat.loanType,
    product_type: row.Product_Type || null,
    target_customer: row.Target_Customer || null,
    purpose: row.Purpose || null,
    policy_version: row.Policy_Version || null,
    min_loan_amount: toNumber(row.Minimum_Loan_Amount),
    max_loan_amount: toNumber(row.Maximum_Loan_Amount),
    min_tenure_months: toNumber(row.Minimum_Tenure_Months),
    max_tenure_months: toNumber(row.Maximum_Tenure_Months),
    interest_rate_min: toNumber(row.Interest_Rate_From),
    interest_rate_max: toNumber(row.Interest_Rate_To),
    minAmount: toNumber(row.Minimum_Loan_Amount),
    maxAmount: toNumber(row.Maximum_Loan_Amount),
    minTenure: toNumber(row.Minimum_Tenure_Months)
      ? `${toNumber(row.Minimum_Tenure_Months)} months`
      : undefined,
    maxTenure: toNumber(row.Maximum_Tenure_Months)
      ? `${toNumber(row.Maximum_Tenure_Months)} months`
      : undefined,
    interestRate:
      toNumber(row.Interest_Rate_From) != null
        ? `${toNumber(row.Interest_Rate_From)}% - ${toNumber(row.Interest_Rate_To) ?? ''}%`
        : undefined,
    processingFee,
    maximum_foir_percentage: obligation
      ? toNumber(obligation.Maximum_FOIR_Percentage)
      : undefined,
    policy_pack_source: 'lender_policy_bulk_upload',
  };

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
  if (job.status === 'committed') {
    const e = new Error('Import job already committed');
    e.status = 409;
    throw e;
  }
  // Allow commit from validated (force) or approved

  const sheets =
    typeof job.sheet_payload_json === 'string'
      ? JSON.parse(job.sheet_payload_json)
      : job.sheet_payload_json || {};

  const idMap = {
    lenders: {},
    products: {},
    feesByProduct: {},
    obligationsByProduct: {},
  };
  for (const fee of sheets.Fees || []) {
    if (!idMap.feesByProduct[fee.Product_ID]) idMap.feesByProduct[fee.Product_ID] = [];
    idMap.feesByProduct[fee.Product_ID].push(fee);
  }
  for (const ob of sheets.Obligation_Rules || []) {
    if (!idMap.obligationsByProduct[ob.Product_ID]) idMap.obligationsByProduct[ob.Product_ID] = [];
    idMap.obligationsByProduct[ob.Product_ID].push(ob);
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

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    for (const row of sheets.Lenders || []) {
      const r = await upsertLender(conn, row, committedBy, idMap);
      if (r.action === 'created') result.lendersCreated += 1;
      if (r.action === 'updated') result.lendersUpdated += 1;
    }
    for (const row of sheets.Products || []) {
      const r = await upsertProduct(conn, row, idMap);
      if (r.action === 'created') result.productsCreated += 1;
      if (r.action === 'updated') result.productsUpdated += 1;
    }

    try {
      await upsertPricingRules(conn, sheets, idMap, result);
    } catch (err) {
      result.pricingError = err.message;
    }
    try {
      await upsertDocumentRules(conn, sheets, idMap, result);
    } catch (err) {
      result.documentsError = err.message;
    }

    try {
      await upsertPolicyPackFromSheets(conn, sheets, idMap, result, committedBy);
    } catch (err) {
      result.policyPackError = err.message;
    }

    try {
      await ensureLenderGeoPolicySchema(conn);
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
          conn,
        });
        result.geoVersionId = geo.versionId;
        result.geoRowsInserted = geo.inserted;
        result.geoStatus = geo.status;
        result.geoNote =
          'Geo version created as pending_approval — Super Admin must approve before live eligibility uses it.';
      }
    } catch (err) {
      result.geoError = err.message;
    }

    await conn.execute(
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

    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export function buildPolicyTemplateWorkbook() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['Rfincare — Loan Advisory Lender Product Bulk Upload'],
      ['Workflow: Upload → Validate → Preview → Approve → Publish'],
      ['1. Fill Lenders and Products (required).'],
      ['2. Optional: Pricing_Rules, Document_Rules, Fees, Obligation_Rules, eligibility rule sheets, Policy_Versions, Matching_Rules, LTV/Risk/Exceptions.'],
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
