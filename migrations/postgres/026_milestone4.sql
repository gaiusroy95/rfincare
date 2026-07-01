-- Milestone 4: CIBIL, file notifications, document-only journey, commission ledger

CREATE TABLE IF NOT EXISTS cibil_vendors (
  vendor_key VARCHAR(32) NOT NULL PRIMARY KEY,
  display_name VARCHAR(128) NOT NULL,
  api_key VARCHAR(512) NULL,
  api_secret VARCHAR(512) NULL,
  sandbox_mode BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by CHAR(36) NULL,
  updated_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO cibil_vendors (vendor_key, display_name, sandbox_mode, is_active) VALUES
  ('transunion_cibil', 'TransUnion CIBIL', 1, 0),
  ('experian', 'Experian', 1, 0),
  ('equifax', 'Equifax', 1, 0),
  ('crif_high_mark', 'CRIF High Mark', 1, 0)
ON CONFLICT (vendor_key) DO UPDATE SET display_name = EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS cibil_checks (
  id CHAR(36) NOT NULL PRIMARY KEY,
  application_id CHAR(36) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  vendor_key VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  credit_score INT NULL,
  report_path TEXT NULL,
  error_message TEXT NULL,
  request_payload JSON NULL,
  response_payload JSON NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS file_notification_settings (
  id VARCHAR(16) NOT NULL PRIMARY KEY,
  settings_json JSON NOT NULL,
  updated_by CHAR(36) NULL,
  updated_at TIMESTAMPTZ NULL
);

INSERT INTO file_notification_settings (id, settings_json) VALUES (
  'default',
  JSON_OBJECT(
    'channels', JSON_OBJECT('sms', true, 'email', true, 'whatsapp', true),
    'agentNotificationsEnabled', true,
    'events', JSON_OBJECT(
      'customer_document_upload', JSON_OBJECT('customer', false, 'employee', true, 'agent', 'optional'),
      'employee_document_decision', JSON_OBJECT('customer', true, 'employee', false, 'agent', 'optional'),
      'application_stage_after_bank', JSON_OBJECT('customer', true, 'employee', true, 'agent', 'if_sourced')
    )
  )
) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS staff_notifications (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  role VARCHAR(32) NOT NULL,
  application_id CHAR(36) NULL,
  event_type VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE loan_applications
  ADD COLUMN IF NOT EXISTS journey_mode VARCHAR(32) NOT NULL DEFAULT 'assessment',
  ADD COLUMN IF NOT EXISTS cibil_status VARCHAR(32) NULL,
  ADD COLUMN IF NOT EXISTS cibil_checked_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS disbursed_amount DECIMAL(15, 2) NULL,
  ADD COLUMN IF NOT EXISTS disbursed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS commission_status VARCHAR(32) NULL,
  ADD COLUMN IF NOT EXISTS commission_amount DECIMAL(15, 2) NULL,
  ADD COLUMN IF NOT EXISTS commission_rate DECIMAL(8, 4) NULL,
  ADD COLUMN IF NOT EXISTS tds_amount DECIMAL(15, 2) NULL,
  ADD COLUMN IF NOT EXISTS net_payout DECIMAL(15, 2) NULL,
  ADD COLUMN IF NOT EXISTS commission_paid_at TIMESTAMPTZ NULL;

ALTER TABLE agent_onboarding
  ADD COLUMN IF NOT EXISTS qc_status VARCHAR(32) NOT NULL DEFAULT 'pending_qc',
  ADD COLUMN IF NOT EXISTS qc_employee_id CHAR(36) NULL,
  ADD COLUMN IF NOT EXISTS qc_notes TEXT NULL,
  ADD COLUMN IF NOT EXISTS qc_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS qc_approved_by CHAR(36) NULL;
