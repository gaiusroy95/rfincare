-- Agent commission + employee access controls

CREATE TABLE IF NOT EXISTS agent_commission_config (
  id CHAR(36) NOT NULL,
  agent_user_id CHAR(36) NOT NULL,
  loan_type VARCHAR(64) NULL,
  commission_type VARCHAR(32) NOT NULL DEFAULT 'percentage',
  commission_value DECIMAL(10, 2) NOT NULL DEFAULT 2.5,
  min_loan_amount DECIMAL(15, 2) NULL,
  max_loan_amount DECIMAL(15, 2) NULL,
  effective_from DATE NULL,
  effective_to DATE NULL,
  updated_by CHAR(36) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS employee_access_controls (
  id CHAR(36) NOT NULL,
  employee_user_id CHAR(36) NOT NULL,
  module_name VARCHAR(64) NOT NULL,
  permissions_json JSON NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ NULL,
  updated_by CHAR(36) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT uq_employee_access_module UNIQUE (employee_user_id, module_name)
);
