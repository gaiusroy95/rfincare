import { getPool } from '../db/pool.js';
import { newId } from './ids.js';

/** Exact homepage CIBIL checkbox text (preserve wording for TRAI evidence). */
export const HOMEPAGE_CIBIL_CONSENT_WORDING =
  'I consent to Rfincare fetching my credit score from bureau partners and storing my details for eligibility matching. I here by authorized to send notifications via SMS, Email, RCS and other as per terms of service & privacy policy.';

export const HOMEPAGE_CIBIL_PRODUCT_PURPOSE =
  'Free CIBIL score check and marketing/promotional notifications (SMS, Email, RCS and other channels)';

export const HOMEPAGE_CIBIL_CONSENT_SOURCE = 'website/homepage_cibil';

let schemaReady = false;

export function maskCustomerNumber(phone) {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length < 4) return '******';
  if (digits.length < 10) return `${digits.slice(0, 1)}****${digits.slice(-1)}`;
  return `${digits.slice(0, 2)}******${digits.slice(-2)}`;
}

/** Exact DD/MM/YYYY + time for consent annexure. */
export function formatConsentDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${min}:${ss}`;
}

function resolveTmDetails(overrides = {}) {
  if (overrides.tmDetails) return String(overrides.tmDetails).trim() || null;
  const name = String(process.env.CONSENT_TM_NAME || process.env.TM_NAME || '').trim();
  const id = String(process.env.CONSENT_TM_ID || process.env.TM_ID || '').trim();
  if (name && id) return `${name} / ${id}`;
  if (name) return name;
  if (id) return id;
  return null;
}

function resolveDltRecord(overrides = {}) {
  if (overrides.dltRecord) return String(overrides.dltRecord).trim() || null;
  const explicit = String(
    process.env.CONSENT_DLT_RECORD || process.env.DLT_CONSENT_RECORD || '',
  ).trim();
  if (explicit) return explicit;
  const sender = String(process.env.MSG91_SENDER_ID || '').trim();
  const template = String(
    process.env.MSG91_OTP_TEMPLATE_ID || process.env.MSG91_TEMPLATE_ID || '',
  ).trim();
  const parts = [];
  if (sender) parts.push(`sender:${sender}`);
  if (template) parts.push(`otp_template:${template}`);
  return parts.length ? parts.join('; ') : null;
}

/**
 * Auto-create consent_evidence for TRAI / telecom regulatory annexure.
 * Safe to call repeatedly (CREATE IF NOT EXISTS).
 */
export async function ensureConsentEvidenceSchema(pool = getPool()) {
  if (schemaReady) return;
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS consent_evidence (
      id CHAR(36) PRIMARY KEY,
      consent_record TEXT NOT NULL,
      consent_date VARCHAR(64) NOT NULL,
      consent_date_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      consent_source VARCHAR(128) NOT NULL,
      consent_wording TEXT NOT NULL,
      customer_number VARCHAR(32) NOT NULL,
      product_purpose TEXT NOT NULL,
      relationship VARCHAR(128) NOT NULL,
      relationship_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      tm_details TEXT NULL,
      dlt_record TEXT NULL,
      lead_id CHAR(36) NULL,
      ip_address TEXT NULL,
      user_agent TEXT NULL,
      metadata JSONB NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.execute(
    `CREATE INDEX IF NOT EXISTS idx_consent_evidence_lead_id ON consent_evidence (lead_id)`,
  );
  await pool.execute(
    `CREATE INDEX IF NOT EXISTS idx_consent_evidence_source ON consent_evidence (consent_source)`,
  );
  await pool.execute(
    `CREATE INDEX IF NOT EXISTS idx_consent_evidence_created ON consent_evidence (created_at DESC)`,
  );
  schemaReady = true;
}

/**
 * Persist full TRAI consent evidence row.
 * @returns {{ id: string, consentDate: string }}
 */
export async function insertConsentEvidence(
  {
    consentWording = HOMEPAGE_CIBIL_CONSENT_WORDING,
    consentSource = HOMEPAGE_CIBIL_CONSENT_SOURCE,
    productPurpose = HOMEPAGE_CIBIL_PRODUCT_PURPOSE,
    phone,
    leadId = null,
    relationship = null,
    relationshipDate = null,
    tmDetails = null,
    dltRecord = null,
    ipAddress = null,
    userAgent = null,
    metadata = null,
  } = {},
  pool = getPool(),
) {
  await ensureConsentEvidenceSchema(pool);
  const now = new Date();
  const id = newId();
  const consentDate = formatConsentDate(now);
  const masked = maskCustomerNumber(phone);
  const rel = relationship || (leadId ? `lead:${leadId}` : 'lead:pending');
  const relDate = relationshipDate ? new Date(relationshipDate) : now;

  const record = {
    id,
    consent: true,
    consentDate,
    consentSource,
    consentWording,
    customerNumber: masked,
    productPurpose,
    relationship: rel,
    relationshipDate: formatConsentDate(relDate),
    tmDetails: resolveTmDetails({ tmDetails }),
    dltRecord: resolveDltRecord({ dltRecord }),
  };

  await pool.execute(
    `INSERT INTO consent_evidence
     (id, consent_record, consent_date, consent_date_at, consent_source, consent_wording,
      customer_number, product_purpose, relationship, relationship_date,
      tm_details, dlt_record, lead_id, ip_address, user_agent, metadata)
     VALUES
     (:id, :consent_record, :consent_date, :consent_date_at, :consent_source, :consent_wording,
      :customer_number, :product_purpose, :relationship, :relationship_date,
      :tm_details, :dlt_record, :lead_id, :ip_address, :user_agent, :metadata::jsonb)`,
    {
      id,
      consent_record: JSON.stringify(record),
      consent_date: consentDate,
      consent_date_at: now.toISOString(),
      consent_source: consentSource,
      consent_wording: consentWording,
      customer_number: masked,
      product_purpose: productPurpose,
      relationship: rel,
      relationship_date: relDate.toISOString(),
      tm_details: record.tmDetails,
      dlt_record: record.dltRecord,
      lead_id: leadId || null,
      ip_address: ipAddress || null,
      user_agent: userAgent || null,
      metadata: metadata ? JSON.stringify(metadata) : null,
    },
  );

  return { id, consentDate, record };
}
