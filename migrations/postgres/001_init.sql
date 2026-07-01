CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Initial PostgreSQL schema for Rfincare.
-- Focuses on fields currently referenced by the frontend code.

CREATE TABLE IF NOT EXISTS auth_users (
  id CHAR(36) NOT NULL,
  email VARCHAR(320) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT uq_auth_users_email UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS user_profiles (
  id CHAR(36) NOT NULL,
  email VARCHAR(320) NOT NULL,
  full_name VARCHAR(255) NULL,
  phone VARCHAR(32) NULL,
  role VARCHAR(32) NOT NULL DEFAULT 'customer',
  account_status VARCHAR(32) NOT NULL DEFAULT 'active',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  password_change_required BOOLEAN NOT NULL DEFAULT FALSE,
  failed_login_attempts INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ NULL,
  onboarding_status VARCHAR(64) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT uq_user_profiles_email UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  rotated_to_token_id CHAR(36) NULL,
  user_agent VARCHAR(512) NULL,
  ip_address VARCHAR(64) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_refresh_tokens_user FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
);

-- Core domain tables (minimal columns; extend as needed)
CREATE TABLE IF NOT EXISTS banks (
  id CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  logo_url TEXT NULL,
  logo_alt VARCHAR(255) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  display_priority INT NOT NULL DEFAULT 0,
  created_by CHAR(36) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS bank_products (
  id CHAR(36) NOT NULL,
  bank_id CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  data JSON NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_bank_products_bank FOREIGN KEY (bank_id) REFERENCES banks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS approval_matrix_rules (
  id CHAR(36) NOT NULL,
  bank_id CHAR(36) NOT NULL,
  rule_name VARCHAR(255) NULL,
  priority INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  approval_probability INT NULL,
  data JSON NULL,
  created_by CHAR(36) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_approval_rules_bank FOREIGN KEY (bank_id) REFERENCES banks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS loan_applications (
  id CHAR(36) NOT NULL,
  application_number VARCHAR(64) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  agent_id CHAR(36) NULL,
  assigned_employee_id CHAR(36) NULL,
  selected_bank_id CHAR(36) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  status_notes TEXT NULL,
  review_notes TEXT NULL,
  eligibility_status VARCHAR(64) NULL,
  rejection_reason TEXT NULL,
  submitted_at TIMESTAMPTZ NULL,
  reviewed_by CHAR(36) NULL,
  reviewed_at TIMESTAMPTZ NULL,
  data JSON NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT uq_loan_applications_number UNIQUE (application_number)
);

CREATE TABLE IF NOT EXISTS application_timeline (
  id CHAR(36) NOT NULL,
  application_id CHAR(36) NOT NULL,
  status VARCHAR(32) NOT NULL,
  message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_timeline_application FOREIGN KEY (application_id) REFERENCES loan_applications(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS application_consents (
  id CHAR(36) NOT NULL,
  application_id CHAR(36) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  consent_type VARCHAR(128) NOT NULL,
  is_granted BOOLEAN NOT NULL,
  granted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS otp_verifications (
  id CHAR(36) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  application_id CHAR(36) NOT NULL,
  phone_number VARCHAR(32) NULL,
  email VARCHAR(320) NULL,
  otp_code VARCHAR(16) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS customer_documents (
  id CHAR(36) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  application_id CHAR(36) NULL,
  document_type VARCHAR(64) NULL,
  document_name VARCHAR(255) NULL,
  file_path TEXT NOT NULL,
  document_url TEXT NULL,
  file_size BIGINT NULL,
  mime_type VARCHAR(255) NULL,
  status VARCHAR(32) NULL,
  verification_status VARCHAR(32) NULL,
  verified_by CHAR(36) NULL,
  verified_at TIMESTAMPTZ NULL,
  uploaded_by CHAR(36) NULL,
  uploaded_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS customer_notifications (
  id CHAR(36) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  title VARCHAR(255) NULL,
  message TEXT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NULL,
  action_type VARCHAR(64) NOT NULL,
  table_name VARCHAR(128) NOT NULL,
  record_id VARCHAR(128) NULL,
  old_values JSON NULL,
  new_values JSON NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS indian_states (
  id CHAR(36) NOT NULL,
  state_name VARCHAR(128) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT uq_state_name UNIQUE (state_name)
);

CREATE TABLE IF NOT EXISTS localization_settings (
  id CHAR(36) NOT NULL,
  setting_key VARCHAR(128) NOT NULL,
  setting_value TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT uq_localization_key UNIQUE (setting_key)
);

-- Simple sequence table to generate application numbers (optional, API can also do this)
CREATE TABLE IF NOT EXISTS sequences (
  name VARCHAR(64) NOT NULL,
  value BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (name)
);
