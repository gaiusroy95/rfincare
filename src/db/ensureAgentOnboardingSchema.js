import { getPool } from './pool.js';
import { isIgnorableEnsureError } from './schemaErrors.js';
import { newId } from '../lib/ids.js';

let ensured = false;

const CHECKLIST_SEED = [
  // individual
  ['individual', 'pan_card', 'PAN Card', true, 10, 10],
  ['individual', 'aadhaar_card', 'Aadhaar Card', true, 10, 20],
  ['individual', 'photo', 'Passport Photo', true, 5, 30],
  ['individual', 'signature', 'Signature Specimen', true, 5, 40],
  ['individual', 'cancelled_cheque', 'Cancelled Cheque / Bank Proof', true, 10, 50],
  ['individual', 'address_proof', 'Address Proof', true, 10, 60],
  // proprietorship
  ['proprietorship', 'pan_card', 'Proprietor / Firm PAN', true, 10, 10],
  ['proprietorship', 'aadhaar_card', 'Proprietor Aadhaar', true, 10, 20],
  ['proprietorship', 'photo', 'Proprietor Photo', true, 5, 30],
  ['proprietorship', 'signature', 'Proprietor Signature', true, 5, 40],
  ['proprietorship', 'cancelled_cheque', 'Cancelled Cheque / Bank Proof', true, 10, 50],
  ['proprietorship', 'gst_certificate', 'GST Certificate', false, 10, 60],
  ['proprietorship', 'shop_establishment', 'Shop & Establishment / Trade License', false, 10, 70],
  ['proprietorship', 'address_proof', 'Business Address Proof', true, 10, 80],
  // partnership
  ['partnership', 'partnership_deed', 'Partnership Deed', true, 15, 10],
  ['partnership', 'pan_card', 'Firm PAN', true, 10, 20],
  ['partnership', 'gst_certificate', 'GST Certificate', false, 10, 30],
  ['partnership', 'cancelled_cheque', 'Cancelled Cheque / Bank Proof', true, 10, 40],
  ['partnership', 'authorization_letter', 'Authorisation Letter', true, 10, 50],
  ['partnership', 'address_proof', 'Firm Address Proof', true, 10, 60],
  ['partnership', 'partner_kyc', 'Partner KYC Pack (PAN/Aadhaar)', true, 15, 70],
  // private_limited
  ['private_limited', 'certificate_of_incorporation', 'Certificate of Incorporation', true, 15, 10],
  ['private_limited', 'moa', 'Memorandum of Association (MOA)', true, 15, 20],
  ['private_limited', 'aoa', 'Articles of Association (AOA)', true, 15, 30],
  ['private_limited', 'board_resolution', 'Board Resolution / Authorisation', true, 10, 40],
  ['private_limited', 'pan_card', 'Company PAN', true, 10, 50],
  ['private_limited', 'gst_certificate', 'GST Certificate', false, 10, 60],
  ['private_limited', 'cancelled_cheque', 'Cancelled Cheque / Bank Proof', true, 10, 70],
  ['private_limited', 'director_kyc', 'Director KYC Pack', true, 15, 80],
  ['private_limited', 'address_proof', 'Registered Office Address Proof', true, 10, 90],
];

const CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS agent_application_id_counters (
    year_label VARCHAR(8) NOT NULL PRIMARY KEY,
    last_seq INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS agent_applications (
    id CHAR(36) NOT NULL PRIMARY KEY,
    application_id VARCHAR(32) NOT NULL,
    entity_type VARCHAR(32) NULL,
    workflow_status VARCHAR(48) NOT NULL DEFAULT 'draft',
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(32) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NULL,
    state VARCHAR(128) NULL,
    city VARCHAR(128) NULL,
    pin_code VARCHAR(16) NULL,
    referral_code VARCHAR(64) NULL,
    entity_payload JSONB NULL,
    bank_holder_name VARCHAR(255) NULL,
    bank_name VARCHAR(255) NULL,
    bank_account_number VARCHAR(64) NULL,
    bank_ifsc VARCHAR(32) NULL,
    bank_account_type VARCHAR(32) NULL,
    bank_verify_status VARCHAR(48) NOT NULL DEFAULT 'pending_verification',
    agreements_json JSONB NULL,
    agreements_accepted_at TIMESTAMPTZ NULL,
    agreements_ip VARCHAR(64) NULL,
    agreements_user_agent VARCHAR(512) NULL,
    submitted_at TIMESTAMPTZ NULL,
    activated_user_id CHAR(36) NULL,
    assigned_agent_code VARCHAR(64) NULL,
    rejection_reason TEXT NULL,
    legacy_partner_registration_id CHAR(36) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_agent_applications_application_id UNIQUE (application_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_applications_email ON agent_applications (email)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_applications_phone ON agent_applications (phone)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_applications_status ON agent_applications (workflow_status)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_applications_created ON agent_applications (created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS agent_application_parties (
    id CHAR(36) NOT NULL PRIMARY KEY,
    application_id CHAR(36) NOT NULL,
    party_role VARCHAR(32) NOT NULL,
    full_name VARCHAR(255) NULL,
    dob DATE NULL,
    pan VARCHAR(16) NULL,
    mobile VARCHAR(32) NULL,
    email VARCHAR(255) NULL,
    address TEXT NULL,
    din VARCHAR(32) NULL,
    designation VARCHAR(128) NULL,
    ownership_pct NUMERIC(8, 4) NULL,
    is_authorised BOOLEAN NOT NULL DEFAULT FALSE,
    photo_path VARCHAR(512) NULL,
    signature_path VARCHAR(512) NULL,
    kyc_doc_path VARCHAR(512) NULL,
    sort_order INT NOT NULL DEFAULT 0,
    meta_json JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_application_parties_app
    ON agent_application_parties (application_id, sort_order)`,
  `CREATE TABLE IF NOT EXISTS agent_application_documents (
    id CHAR(36) NOT NULL PRIMARY KEY,
    application_id CHAR(36) NOT NULL,
    document_type VARCHAR(64) NOT NULL,
    is_mandatory BOOLEAN NOT NULL DEFAULT TRUE,
    document_number VARCHAR(128) NULL,
    issue_date DATE NULL,
    expiry_date DATE NULL,
    file_path VARCHAR(512) NULL,
    status VARCHAR(48) NOT NULL DEFAULT 'uploaded',
    rejection_reason TEXT NULL,
    uploaded_at TIMESTAMPTZ NULL,
    reviewed_at TIMESTAMPTZ NULL,
    reviewed_by CHAR(36) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_application_documents_app
    ON agent_application_documents (application_id, document_type)`,
  `CREATE TABLE IF NOT EXISTS agent_application_actions (
    id CHAR(36) NOT NULL PRIMARY KEY,
    application_id CHAR(36) NOT NULL,
    actor_user_id CHAR(36) NULL,
    actor_label VARCHAR(128) NULL,
    action VARCHAR(64) NOT NULL,
    remarks TEXT NULL,
    ip VARCHAR(64) NULL,
    user_agent VARCHAR(512) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_application_actions_app
    ON agent_application_actions (application_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS agent_document_checklist_templates (
    id CHAR(36) NOT NULL PRIMARY KEY,
    entity_type VARCHAR(32) NOT NULL,
    document_type VARCHAR(64) NOT NULL,
    label VARCHAR(255) NOT NULL,
    is_mandatory BOOLEAN NOT NULL DEFAULT TRUE,
    max_size_mb INT NOT NULL DEFAULT 10,
    sort_order INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_doc_checklist_entity
    ON agent_document_checklist_templates (entity_type, sort_order)`,
];

async function seedChecklistTemplates(pool) {
  const [[countRow]] = await pool.execute(
    `SELECT COUNT(*)::int AS cnt FROM agent_document_checklist_templates`,
  );
  if (Number(countRow?.cnt || 0) > 0) return;

  for (const [entityType, documentType, label, isMandatory, maxSizeMb, sortOrder] of CHECKLIST_SEED) {
    try {
      await pool.execute(
        `INSERT INTO agent_document_checklist_templates (
           id, entity_type, document_type, label, is_mandatory, max_size_mb, sort_order, is_active
         ) VALUES (
           :id, :entity_type, :document_type, :label, :is_mandatory, :max_size_mb, :sort_order, TRUE
         )`,
        {
          id: newId(),
          entity_type: entityType,
          document_type: documentType,
          label,
          is_mandatory: isMandatory,
          max_size_mb: maxSizeMb,
          sort_order: sortOrder,
        },
      );
    } catch (err) {
      if (!isIgnorableEnsureError(err)) throw err;
    }
  }
}

/** Create agent onboarding tables if migrations have not been applied; seed checklist when empty. */
export async function ensureAgentOnboardingSchema() {
  if (ensured) return;
  const pool = getPool();

  for (const sql of CREATE_STATEMENTS) {
    try {
      await pool.execute(sql);
    } catch (err) {
      if (!isIgnorableEnsureError(err)) throw err;
    }
  }

  try {
    await seedChecklistTemplates(pool);
  } catch (err) {
    if (!isIgnorableEnsureError(err)) throw err;
  }

  ensured = true;
}
