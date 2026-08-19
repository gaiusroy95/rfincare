import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getPool } from '../db/pool.js';
import { newId } from './ids.js';
import { buildSimpleTextPdf } from './simplePdf.js';
import { getUploadDir } from './uploadPaths.js';
import { ensureMilestone4Schema } from '../db/ensureMilestone4Schema.js';
import {
  requestSurepassCibilPdf,
  saveCibilPdfBuffer,
  surepassConfigured,
} from './surepassCibil.js';

const VENDOR_KEYS = ['transunion_cibil', 'experian', 'equifax', 'crif_high_mark'];

function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function firstValue(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return '';
}

export function extractCibilDemographics({ application, customer, extra = {} } = {}) {
  const data = parseJson(application?.data);
  const personal = parseJson(data.personal) || {};
  const merged = { ...data, ...personal, ...extra };
  const name =
    extra.fullName
    || customer?.full_name
    || [merged.firstName || merged.first_name, merged.lastName || merged.last_name]
      .filter(Boolean)
      .join(' ')
    || firstValue(merged, ['fullName', 'full_name', 'name', 'applicant_name']);
  return {
    name,
    pan: firstValue(merged, ['panNumber', 'pan_number', 'pan', 'id_number']).toUpperCase(),
    mobile: firstValue(merged, ['phone', 'mobile', 'mobile_number', 'mobileNo']) || customer?.phone,
    dob: firstValue(merged, ['dateOfBirth', 'date_of_birth', 'dob']),
    gender: firstValue(merged, ['gender']),
    consent: extra.consent !== false,
  };
}

export async function listCibilVendors() {
  await ensureMilestone4Schema();
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT vendor_key, display_name, sandbox_mode, is_active,
            CASE WHEN api_key IS NOT NULL AND api_key != '' THEN 1 ELSE 0 END AS has_key,
            updated_at
     FROM cibil_vendors ORDER BY vendor_key`,
  );
  return rows.map((r) => ({
    vendorKey: r.vendor_key,
    displayName: r.display_name,
    sandboxMode: Boolean(r.sandbox_mode),
    isActive: Boolean(r.is_active),
    hasCredentials: Boolean(r.has_key) || (r.vendor_key === 'transunion_cibil' && surepassConfigured(r)),
    updatedAt: r.updated_at,
  }));
}

export async function updateCibilVendor(vendorKey, payload, updatedBy) {
  if (!VENDOR_KEYS.includes(vendorKey)) {
    const e = new Error('Unknown CIBIL vendor');
    e.status = 400;
    throw e;
  }
  await ensureMilestone4Schema();
  const pool = getPool();
  await pool.execute(
    `UPDATE cibil_vendors
     SET api_key = COALESCE(:api_key, api_key),
         api_secret = COALESCE(:api_secret, api_secret),
         sandbox_mode = COALESCE(:sandbox, sandbox_mode),
         is_active = COALESCE(:active, is_active),
         updated_by = :by,
         updated_at = NOW()
     WHERE vendor_key = :key`,
    {
      key: vendorKey,
      api_key: payload.apiKey ?? null,
      api_secret: payload.apiSecret ?? null,
      sandbox: payload.sandboxMode == null ? null : payload.sandboxMode ? 1 : 0,
      active: payload.isActive == null ? null : payload.isActive ? 1 : 0,
      by: updatedBy,
    },
  );
  if (payload.isActive) {
    await pool.execute(`UPDATE cibil_vendors SET is_active = FALSE WHERE vendor_key != :key`, {
      key: vendorKey,
    });
    await pool.execute(`UPDATE cibil_vendors SET is_active = TRUE WHERE vendor_key = :key`, {
      key: vendorKey,
    });
  }
  return listCibilVendors();
}

async function getActiveVendor(pool) {
  const [[row]] = await pool.execute(
    `SELECT * FROM cibil_vendors WHERE is_active = TRUE LIMIT 1`,
  );
  return row;
}

function writeLocalSandboxPdf({ vendor, application, customer, score }) {
  const data = parseJson(application?.data);
  const reportDir = resolve(getUploadDir(), 'cibil-reports');
  mkdirSync(reportDir, { recursive: true });
  const refId = application?.id || customer?.id || newId();
  const fileName = `${refId}-${Date.now()}.pdf`;
  const reportPath = resolve(reportDir, fileName);
  const lines = [
    'Rfincare — Credit Bureau Report (Local sandbox fallback)',
    `Vendor: ${vendor.display_name}`,
    `Application: ${application?.application_number || application?.id || 'Customer pull'}`,
    `Customer: ${customer?.full_name || '—'}`,
    `PAN: ${data?.pan_number || data?.panNumber || '—'}`,
    `Score: ${score}`,
    `Checked at: ${new Date().toISOString()}`,
    '',
    'Surepass credentials were not set, so this PDF is a local sandbox stub.',
    'Set SUREPASS_TOKEN or SUREPASS_ID_NUMBER + SUREPASS_PASSWORD to pull a real CIBIL PDF.',
  ];
  writeFileSync(reportPath, buildSimpleTextPdf(lines));
  return `/uploads/cibil-reports/${fileName}`;
}

async function sandboxPull({ vendor, application, customer, extra }) {
  const demographics = extractCibilDemographics({ application, customer, extra });
  if (surepassConfigured(vendor)) {
    const live = await surepassPull({ vendor, application, customer, extra, allowMissingScore: true });
    if (live.status === 'success') return live;
  }

  const score = 680 + Math.floor(Math.random() * 120);
  return {
    status: 'success',
    creditScore: score,
    reportPath: writeLocalSandboxPdf({ vendor, application, customer, score }),
    response: {
      sandbox: true,
      localFallback: true,
      vendor: vendor.vendor_key,
      score,
      demographics: { pan: demographics.pan, mobile: demographics.mobile },
    },
  };
}

async function surepassPull({ vendor, application, customer, extra, allowMissingScore = false }) {
  const demographics = extractCibilDemographics({ application, customer, extra });
  const result = await requestSurepassCibilPdf(demographics, vendor);
  if (!result.ok) {
    return {
      status: 'failed',
      creditScore: null,
      reportPath: null,
      errorMessage: result.errorMessage,
      response: result.response || { reason: result.reason },
    };
  }

  let reportPath = null;
  if (result.pdfBuffer) {
    const stem = application?.id || customer?.id || newId();
    reportPath = saveCibilPdfBuffer(result.pdfBuffer, stem);
  } else if (result.creditScore != null || allowMissingScore) {
    reportPath = writeLocalSandboxPdf({
      vendor,
      application,
      customer,
      score: result.creditScore || '—',
    });
  }

  if (result.creditScore == null && !allowMissingScore) {
    return {
      status: result.pdfBuffer ? 'success' : 'failed',
      creditScore: null,
      reportPath,
      errorMessage: result.pdfBuffer ? null : 'Surepass returned no credit score or PDF',
      response: result.response,
    };
  }

  return {
    status: 'success',
    creditScore: result.creditScore,
    reportPath,
    response: {
      vendor: 'surepass',
      path: result.path,
      clientId: result.clientId,
      pdfUrl: result.pdfUrl,
      sandbox: result.sandbox,
      payload: result.response,
    },
  };
}

async function productionPull({ vendor, application, customer, extra }) {
  if (!surepassConfigured(vendor)) {
    return {
      status: 'failed',
      creditScore: null,
      reportPath: null,
      errorMessage:
        'Surepass credentials missing. Set SUREPASS_TOKEN or SUREPASS_ID_NUMBER + SUREPASS_PASSWORD (or save API key on the TransUnion CIBIL vendor).',
      response: { error: 'missing_credentials' },
    };
  }
  return surepassPull({ vendor, application, customer, extra });
}

export async function pullCibilForApplication(applicationId, { forceSandbox = false } = {}) {
  await ensureMilestone4Schema();
  const pool = getPool();
  const [[application]] = await pool.execute(
    `SELECT la.*, c.full_name, c.email, c.phone
     FROM loan_applications la
     JOIN user_profiles c ON c.id = la.customer_id
     WHERE la.id = :id LIMIT 1`,
    { id: applicationId },
  );
  if (!application) {
    const e = new Error('Application not found');
    e.status = 404;
    throw e;
  }

  const vendor = await getActiveVendor(pool);
  if (!vendor) {
    const e = new Error('No active CIBIL vendor configured in admin panel');
    e.status = 400;
    throw e;
  }

  const useSandbox = forceSandbox || Boolean(vendor.sandbox_mode);
  const result = useSandbox
    ? await sandboxPull({ vendor, application, customer: application })
    : await productionPull({ vendor, application, customer: application });

  const checkId = newId();
  await pool.execute(
    `INSERT INTO cibil_checks
     (id, application_id, customer_id, vendor_key, status, credit_score, report_path, error_message, response_payload)
     VALUES (:id, :app, :cust, :vendor, :status, :score, :path, :err, :resp::jsonb)`,
    {
      id: checkId,
      app: applicationId,
      cust: application.customer_id,
      vendor: vendor.vendor_key,
      status: result.status,
      score: result.creditScore,
      path: result.reportPath,
      err: result.errorMessage || null,
      resp: JSON.stringify(result.response || {}),
    },
  );

  await pool.execute(
    `UPDATE loan_applications
     SET cibil_status = :status, cibil_checked_at = NOW()
     WHERE id = :id`,
    { id: applicationId, status: result.status },
  );

  return {
    checkId,
    vendorKey: vendor.vendor_key,
    vendorName: vendor.display_name,
    ...result,
  };
}

export async function getLatestCibilCheck(applicationId) {
  await ensureMilestone4Schema();
  const pool = getPool();
  const [[row]] = await pool.execute(
    `SELECT cc.*, cv.display_name AS vendor_name
     FROM cibil_checks cc
     LEFT JOIN cibil_vendors cv ON cv.vendor_key = cc.vendor_key
     WHERE cc.application_id = :id
     ORDER BY cc.checked_at DESC LIMIT 1`,
    { id: applicationId },
  );
  if (!row) return null;
  return {
    id: row.id,
    applicationId: row.application_id,
    vendorKey: row.vendor_key,
    vendorName: row.vendor_name,
    status: row.status,
    creditScore: row.credit_score,
    reportPath: row.report_path,
    errorMessage: row.error_message,
    checkedAt: row.checked_at,
  };
}

export async function requireSuccessfulCibilForSubmit(applicationId) {
  const latest = await getLatestCibilCheck(applicationId);
  if (!latest || latest.status !== 'success') {
    const pull = await pullCibilForApplication(applicationId);
    if (pull.status !== 'success') {
      const e = new Error(
        pull.errorMessage
          || 'CIBIL verification failed. Application saved for manual review — contact operations.',
      );
      e.status = 422;
      e.cibilStatus = pull.status;
      throw e;
    }
    return pull;
  }
  return latest;
}

const CUSTOMER_PULL_COOLDOWN_DAYS = 30;

export async function getLatestCustomerCibilCheck(customerId) {
  await ensureMilestone4Schema();
  const pool = getPool();
  const [[row]] = await pool.execute(
    `SELECT cc.*, cv.display_name AS vendor_name, cv.sandbox_mode
     FROM cibil_checks cc
     LEFT JOIN cibil_vendors cv ON cv.vendor_key = cc.vendor_key
     WHERE cc.customer_id = :id AND cc.status = 'success'
     ORDER BY cc.checked_at DESC LIMIT 1`,
    { id: customerId },
  );
  if (!row) return null;
  return {
    id: row.id,
    applicationId: row.application_id,
    vendorKey: row.vendor_key,
    vendorName: row.vendor_name,
    sandboxMode: Boolean(row.sandbox_mode),
    status: row.status,
    creditScore: row.credit_score,
    reportPath: row.report_path,
    errorMessage: row.error_message,
    checkedAt: row.checked_at,
  };
}

export async function pullCibilForCustomer(customerId, { forceSandbox = false } = {}) {
  await ensureMilestone4Schema();
  const pool = getPool();
  const [[customer]] = await pool.execute(
    `SELECT id, full_name, email, phone, role FROM user_profiles WHERE id = :id LIMIT 1`,
    { id: customerId },
  );
  if (!customer) {
    const e = new Error('Customer not found');
    e.status = 404;
    throw e;
  }
  if (customer.role !== 'customer') {
    const e = new Error('Customer access only');
    e.status = 403;
    throw e;
  }

  if (!forceSandbox) {
    const latest = await getLatestCustomerCibilCheck(customerId);
    if (latest?.checkedAt) {
      const daysSince =
        (Date.now() - new Date(latest.checkedAt).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < CUSTOMER_PULL_COOLDOWN_DAYS) {
        const e = new Error(
          `Credit score was checked recently. You can request again in ${Math.ceil(CUSTOMER_PULL_COOLDOWN_DAYS - daysSince)} day(s).`,
        );
        e.status = 429;
        e.latestCheck = latest;
        throw e;
      }
    }
  }

  const vendor = await getActiveVendor(pool);
  if (!vendor) {
    const e = new Error('No active CIBIL vendor configured in admin panel');
    e.status = 400;
    throw e;
  }

  const [[latestApp]] = await pool.execute(
    `SELECT id, data FROM loan_applications WHERE customer_id = :id ORDER BY updated_at DESC LIMIT 1`,
    { id: customerId },
  );
  const stubApplication = latestApp || { id: customer.id, data: '{}' };
  const useSandbox = forceSandbox || Boolean(vendor.sandbox_mode);
  const result = useSandbox
    ? await sandboxPull({ vendor, application: stubApplication, customer })
    : await productionPull({ vendor, application: stubApplication, customer });

  const checkId = newId();
  await pool.execute(
    `INSERT INTO cibil_checks
     (id, application_id, customer_id, vendor_key, status, credit_score, report_path, error_message, response_payload)
     VALUES (:id, NULL, :cust, :vendor, :status, :score, :path, :err, :resp::jsonb)`,
    {
      id: checkId,
      cust: customerId,
      vendor: vendor.vendor_key,
      status: result.status,
      score: result.creditScore,
      path: result.reportPath,
      err: result.errorMessage || null,
      resp: JSON.stringify({ ...result.response, source: 'customer_portal' }),
    },
  );

  return {
    checkId,
    vendorKey: vendor.vendor_key,
    vendorName: vendor.display_name,
    sandboxMode: useSandbox,
    ...result,
  };
}

function scoreBand(score) {
  if (score >= 750) return 'excellent';
  if (score >= 700) return 'good';
  if (score >= 650) return 'fair';
  return 'needs_improvement';
}

const BAND_LABELS = {
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Fair',
  needs_improvement: 'Needs improvement',
};

/**
 * Guest / homepage CIBIL check — captures demographics, stores lead, returns Surepass or sandbox pull.
 */
export async function pullCibilForGuest(demographics, { upsertLead } = {}) {
  await ensureMilestone4Schema();
  const pool = getPool();
  const vendor = await getActiveVendor(pool);
  if (!vendor) {
    const e = new Error('CIBIL check is temporarily unavailable. Please try again later.');
    e.status = 503;
    throw e;
  }

  const stubCustomer = {
    id: newId(),
    full_name: demographics.fullName,
    email: demographics.email,
    phone: demographics.phone,
  };
  const stubApplication = {
    id: stubCustomer.id,
    data: JSON.stringify({
      pan_number: demographics.panNumber,
      panNumber: demographics.panNumber,
      date_of_birth: demographics.dateOfBirth,
      dateOfBirth: demographics.dateOfBirth,
      city: demographics.city,
      pincode: demographics.pincode,
      gender: demographics.gender || null,
    }),
  };
  const extra = {
    fullName: demographics.fullName,
    consent: true,
  };

  const useSandbox = Boolean(vendor.sandbox_mode);
  const result = useSandbox
    ? await sandboxPull({ vendor, application: stubApplication, customer: stubCustomer, extra })
    : await productionPull({ vendor, application: stubApplication, customer: stubCustomer, extra });

  let leadId = null;
  if (typeof upsertLead === 'function') {
    const lead = await upsertLead(pool);
    leadId = lead?.row?.id || null;
    if (leadId) {
      await pool.execute(
        `UPDATE marketing_leads
         SET eligibility_data = :data, eligibility_score = :score, updated_at = NOW()
         WHERE id = :id`,
        {
          id: leadId,
          score: result.creditScore ?? null,
          data: JSON.stringify({
            source: 'homepage_cibil',
            demographics,
            cibil: {
              status: result.status,
              creditScore: result.creditScore,
              vendorKey: vendor.vendor_key,
              vendorName: vendor.display_name,
              sandboxMode: useSandbox,
              checkedAt: new Date().toISOString(),
            },
          }),
        },
      );
    }
  }

  if (result.status !== 'success') {
    const e = new Error(result.errorMessage || 'Could not fetch CIBIL score');
    e.status = 422;
    throw e;
  }

  const band = scoreBand(result.creditScore || 0);
  return {
    leadId,
    creditScore: result.creditScore,
    band: result.creditScore ? band : 'unknown',
    bandLabel: result.creditScore ? BAND_LABELS[band] : 'Report generated',
    vendorName: vendor.display_name,
    sandboxMode: useSandbox,
    checkedAt: new Date().toISOString(),
  };
}

export async function syncSurepassVendorFromEnv(pool = getPool()) {
  const token = String(process.env.SUREPASS_TOKEN || '').trim();
  const sandbox = String(process.env.SUREPASS_SANDBOX || 'true') !== 'false';
  await pool.execute(
    `INSERT INTO cibil_vendors (vendor_key, display_name, api_key, sandbox_mode, is_active, updated_at)
     VALUES ('transunion_cibil', 'TransUnion CIBIL (Surepass)', :api_key, :sandbox, TRUE, NOW())
     ON CONFLICT (vendor_key) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       api_key = COALESCE(NULLIF(EXCLUDED.api_key, ''), cibil_vendors.api_key),
       sandbox_mode = EXCLUDED.sandbox_mode,
       is_active = TRUE,
       updated_at = NOW()`,
    {
      api_key: token || null,
      sandbox: sandbox ? 1 : 0,
    },
  );
  await pool.execute(
    `UPDATE cibil_vendors SET is_active = FALSE WHERE vendor_key != 'transunion_cibil'`,
  );
}
