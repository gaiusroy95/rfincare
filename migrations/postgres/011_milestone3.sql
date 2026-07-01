-- Milestone 3: customer codes, interest matrix, report schedules

ALTER TABLE user_profiles
  ADD COLUMN customer_code VARCHAR(32) NULL,
  ADD CONSTRAINT uq_user_profiles_customer_code UNIQUE (customer_code);

CREATE TABLE IF NOT EXISTS interest_matrix_rates (
  id CHAR(36) NOT NULL,
  product_type VARCHAR(128) NOT NULL,
  loan_type VARCHAR(64) NOT NULL DEFAULT 'Unsecured',
  credit_score_min INT NOT NULL DEFAULT 0,
  credit_score_max INT NOT NULL DEFAULT 900,
  loan_amount_min DECIMAL(15, 2) NOT NULL DEFAULT 0,
  loan_amount_max DECIMAL(15, 2) NOT NULL DEFAULT 0,
  term_min INT NOT NULL DEFAULT 0,
  term_max INT NOT NULL DEFAULT 0,
  interest_rate DECIMAL(6, 3) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  effective_date DATE NULL,
  change_note TEXT NULL,
  modified_by CHAR(36) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS report_schedules (
  id CHAR(36) NOT NULL,
  report_key VARCHAR(64) NOT NULL,
  report_name VARCHAR(255) NOT NULL,
  frequency VARCHAR(32) NOT NULL DEFAULT 'weekly',
  format VARCHAR(16) NOT NULL DEFAULT 'csv',
  recipients TEXT NOT NULL,
  filters_json JSON NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at TIMESTAMPTZ NULL,
  created_by CHAR(36) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);
