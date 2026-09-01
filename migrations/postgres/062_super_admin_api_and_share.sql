-- Payment gateway settings (admin-editable; secrets optional override of env)

CREATE TABLE IF NOT EXISTS payment_gateway_settings (
  id CHAR(36) NOT NULL,
  provider VARCHAR(32) NOT NULL DEFAULT 'razorpay',
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  mode VARCHAR(16) NOT NULL DEFAULT 'live',
  key_id VARCHAR(128) NULL,
  key_secret_encrypted TEXT NULL,
  webhook_secret_encrypted TEXT NULL,
  notes TEXT NULL,
  updated_by CHAR(36) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

INSERT INTO payment_gateway_settings (id, provider, is_enabled, mode)
VALUES ('default', 'razorpay', TRUE, 'live')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS application_bank_share_log (
  id CHAR(36) NOT NULL,
  application_id CHAR(36) NOT NULL,
  bank_id CHAR(36) NULL,
  bank_name VARCHAR(255) NULL,
  location_label VARCHAR(255) NULL,
  branch_label VARCHAR(255) NULL,
  employee_name VARCHAR(255) NULL,
  employee_email VARCHAR(320) NOT NULL,
  cc_emails TEXT NULL,
  shared_by CHAR(36) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'sent',
  detail_json JSON NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_application_bank_share_app
  ON application_bank_share_log (application_id, created_at DESC);
