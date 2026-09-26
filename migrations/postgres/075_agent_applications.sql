-- Direct Agent Onboarding: applications, parties, documents, actions, checklist templates

CREATE TABLE IF NOT EXISTS agent_application_id_counters (
  year_label VARCHAR(8) NOT NULL PRIMARY KEY,
  last_seq INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_applications (
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
);

CREATE INDEX IF NOT EXISTS idx_agent_applications_email ON agent_applications (email);
CREATE INDEX IF NOT EXISTS idx_agent_applications_phone ON agent_applications (phone);
CREATE INDEX IF NOT EXISTS idx_agent_applications_status ON agent_applications (workflow_status);
CREATE INDEX IF NOT EXISTS idx_agent_applications_created ON agent_applications (created_at DESC);

CREATE TABLE IF NOT EXISTS agent_application_parties (
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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_agent_application_parties_app
    FOREIGN KEY (application_id) REFERENCES agent_applications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_application_parties_app
  ON agent_application_parties (application_id, sort_order);

CREATE TABLE IF NOT EXISTS agent_application_documents (
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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_agent_application_documents_app
    FOREIGN KEY (application_id) REFERENCES agent_applications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_application_documents_app
  ON agent_application_documents (application_id, document_type);

CREATE TABLE IF NOT EXISTS agent_application_actions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  application_id CHAR(36) NOT NULL,
  actor_user_id CHAR(36) NULL,
  actor_label VARCHAR(128) NULL,
  action VARCHAR(64) NOT NULL,
  remarks TEXT NULL,
  ip VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_agent_application_actions_app
    FOREIGN KEY (application_id) REFERENCES agent_applications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_application_actions_app
  ON agent_application_actions (application_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_document_checklist_templates (
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
);

CREATE INDEX IF NOT EXISTS idx_agent_doc_checklist_entity
  ON agent_document_checklist_templates (entity_type, sort_order);

-- Seed checklist templates (idempotent via NOT EXISTS on entity+document_type)
INSERT INTO agent_document_checklist_templates (id, entity_type, document_type, label, is_mandatory, max_size_mb, sort_order, is_active)
SELECT v.id, v.entity_type, v.document_type, v.label, v.is_mandatory, v.max_size_mb, v.sort_order, TRUE
FROM (
  VALUES
    -- individual
    ('a0750001-0001-4000-8000-000000000001', 'individual', 'pan_card', 'PAN Card', TRUE, 10, 10),
    ('a0750001-0001-4000-8000-000000000002', 'individual', 'aadhaar_card', 'Aadhaar Card', TRUE, 10, 20),
    ('a0750001-0001-4000-8000-000000000003', 'individual', 'photo', 'Passport Photo', TRUE, 5, 30),
    ('a0750001-0001-4000-8000-000000000004', 'individual', 'signature', 'Signature Specimen', TRUE, 5, 40),
    ('a0750001-0001-4000-8000-000000000005', 'individual', 'cancelled_cheque', 'Cancelled Cheque / Bank Proof', TRUE, 10, 50),
    ('a0750001-0001-4000-8000-000000000006', 'individual', 'address_proof', 'Address Proof', TRUE, 10, 60),
    -- proprietorship
    ('a0750001-0002-4000-8000-000000000001', 'proprietorship', 'pan_card', 'Proprietor / Firm PAN', TRUE, 10, 10),
    ('a0750001-0002-4000-8000-000000000002', 'proprietorship', 'aadhaar_card', 'Proprietor Aadhaar', TRUE, 10, 20),
    ('a0750001-0002-4000-8000-000000000003', 'proprietorship', 'photo', 'Proprietor Photo', TRUE, 5, 30),
    ('a0750001-0002-4000-8000-000000000004', 'proprietorship', 'signature', 'Proprietor Signature', TRUE, 5, 40),
    ('a0750001-0002-4000-8000-000000000005', 'proprietorship', 'cancelled_cheque', 'Cancelled Cheque / Bank Proof', TRUE, 10, 50),
    ('a0750001-0002-4000-8000-000000000006', 'proprietorship', 'gst_certificate', 'GST Certificate', FALSE, 10, 60),
    ('a0750001-0002-4000-8000-000000000007', 'proprietorship', 'shop_establishment', 'Shop & Establishment / Trade License', FALSE, 10, 70),
    ('a0750001-0002-4000-8000-000000000008', 'proprietorship', 'address_proof', 'Business Address Proof', TRUE, 10, 80),
    -- partnership
    ('a0750001-0003-4000-8000-000000000001', 'partnership', 'partnership_deed', 'Partnership Deed', TRUE, 15, 10),
    ('a0750001-0003-4000-8000-000000000002', 'partnership', 'pan_card', 'Firm PAN', TRUE, 10, 20),
    ('a0750001-0003-4000-8000-000000000003', 'partnership', 'gst_certificate', 'GST Certificate', FALSE, 10, 30),
    ('a0750001-0003-4000-8000-000000000004', 'partnership', 'cancelled_cheque', 'Cancelled Cheque / Bank Proof', TRUE, 10, 40),
    ('a0750001-0003-4000-8000-000000000005', 'partnership', 'authorization_letter', 'Authorisation Letter', TRUE, 10, 50),
    ('a0750001-0003-4000-8000-000000000006', 'partnership', 'address_proof', 'Firm Address Proof', TRUE, 10, 60),
    ('a0750001-0003-4000-8000-000000000007', 'partnership', 'partner_kyc', 'Partner KYC Pack (PAN/Aadhaar)', TRUE, 15, 70),
    -- private_limited
    ('a0750001-0004-4000-8000-000000000001', 'private_limited', 'certificate_of_incorporation', 'Certificate of Incorporation', TRUE, 15, 10),
    ('a0750001-0004-4000-8000-000000000002', 'private_limited', 'moa', 'Memorandum of Association (MOA)', TRUE, 15, 20),
    ('a0750001-0004-4000-8000-000000000003', 'private_limited', 'aoa', 'Articles of Association (AOA)', TRUE, 15, 30),
    ('a0750001-0004-4000-8000-000000000004', 'private_limited', 'board_resolution', 'Board Resolution / Authorisation', TRUE, 10, 40),
    ('a0750001-0004-4000-8000-000000000005', 'private_limited', 'pan_card', 'Company PAN', TRUE, 10, 50),
    ('a0750001-0004-4000-8000-000000000006', 'private_limited', 'gst_certificate', 'GST Certificate', FALSE, 10, 60),
    ('a0750001-0004-4000-8000-000000000007', 'private_limited', 'cancelled_cheque', 'Cancelled Cheque / Bank Proof', TRUE, 10, 70),
    ('a0750001-0004-4000-8000-000000000008', 'private_limited', 'director_kyc', 'Director KYC Pack', TRUE, 15, 80),
    ('a0750001-0004-4000-8000-000000000009', 'private_limited', 'address_proof', 'Registered Office Address Proof', TRUE, 10, 90)
) AS v(id, entity_type, document_type, label, is_mandatory, max_size_mb, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM agent_document_checklist_templates t
  WHERE t.entity_type = v.entity_type AND t.document_type = v.document_type
);
