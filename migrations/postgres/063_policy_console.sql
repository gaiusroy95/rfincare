-- Multi-lender policy console: versions, rules, property/risk, matching config

CREATE TABLE IF NOT EXISTS product_policy_versions (
  id CHAR(36) NOT NULL,
  bank_id CHAR(36) NOT NULL,
  bank_product_id CHAR(36) NULL,
  external_product_id VARCHAR(128) NULL,
  version_label VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  effective_from DATE NULL,
  effective_to DATE NULL,
  change_reason TEXT NULL,
  snapshot_json JSON NULL,
  created_by CHAR(36) NULL,
  submitted_by CHAR(36) NULL,
  submitted_at TIMESTAMPTZ NULL,
  approved_by CHAR(36) NULL,
  approved_at TIMESTAMPTZ NULL,
  published_by CHAR(36) NULL,
  published_at TIMESTAMPTZ NULL,
  rejected_by CHAR(36) NULL,
  rejected_at TIMESTAMPTZ NULL,
  rejection_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_ppv_bank_product ON product_policy_versions (bank_product_id);
CREATE INDEX IF NOT EXISTS idx_ppv_bank_status ON product_policy_versions (bank_id, status);
CREATE INDEX IF NOT EXISTS idx_ppv_status ON product_policy_versions (status);

CREATE TABLE IF NOT EXISTS policy_change_audit (
  id CHAR(36) NOT NULL,
  version_id CHAR(36) NULL,
  bank_product_id CHAR(36) NULL,
  bank_id CHAR(36) NULL,
  action VARCHAR(64) NOT NULL,
  field_path VARCHAR(255) NULL,
  old_value JSON NULL,
  new_value JSON NULL,
  change_reason TEXT NULL,
  actor_id CHAR(36) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_pca_version ON policy_change_audit (version_id);
CREATE INDEX IF NOT EXISTS idx_pca_created ON policy_change_audit (created_at DESC);

CREATE TABLE IF NOT EXISTS eligibility_rules (
  id CHAR(36) NOT NULL,
  version_id CHAR(36) NULL,
  bank_id CHAR(36) NULL,
  bank_product_id CHAR(36) NULL,
  rule_domain VARCHAR(64) NOT NULL DEFAULT 'applicant',
  rule_code VARCHAR(128) NULL,
  rule_name VARCHAR(255) NOT NULL,
  severity VARCHAR(32) NOT NULL DEFAULT 'soft',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0,
  source_sheet VARCHAR(64) NULL,
  source_row_json JSON NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_er_version ON eligibility_rules (version_id);
CREATE INDEX IF NOT EXISTS idx_er_bank ON eligibility_rules (bank_id);
CREATE INDEX IF NOT EXISTS idx_er_product ON eligibility_rules (bank_product_id);

CREATE TABLE IF NOT EXISTS eligibility_conditions (
  id CHAR(36) NOT NULL,
  rule_id CHAR(36) NOT NULL,
  field_key VARCHAR(128) NOT NULL,
  operator VARCHAR(32) NOT NULL DEFAULT '>=',
  value_json JSON NULL,
  value_to_json JSON NULL,
  logic_group VARCHAR(32) NOT NULL DEFAULT 'AND',
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_ec_rule ON eligibility_conditions (rule_id);

CREATE TABLE IF NOT EXISTS property_ltv_rules (
  id CHAR(36) NOT NULL,
  version_id CHAR(36) NULL,
  bank_id CHAR(36) NULL,
  bank_product_id CHAR(36) NULL,
  property_type VARCHAR(128) NOT NULL DEFAULT 'residential',
  max_ltv NUMERIC(8, 4) NOT NULL DEFAULT 0.75,
  min_amount NUMERIC(18, 2) NULL,
  max_amount NUMERIC(18, 2) NULL,
  applicant_type VARCHAR(64) NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  data_json JSON NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_plt_v ON property_ltv_rules (version_id);
CREATE INDEX IF NOT EXISTS idx_plt_bank ON property_ltv_rules (bank_id);

CREATE TABLE IF NOT EXISTS dscr_rules (
  id CHAR(36) NOT NULL,
  version_id CHAR(36) NULL,
  bank_id CHAR(36) NULL,
  bank_product_id CHAR(36) NULL,
  min_dscr NUMERIC(8, 4) NOT NULL DEFAULT 1.25,
  notes TEXT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS risk_exception_rules (
  id CHAR(36) NOT NULL,
  version_id CHAR(36) NULL,
  bank_id CHAR(36) NULL,
  bank_product_id CHAR(36) NULL,
  rule_type VARCHAR(32) NOT NULL DEFAULT 'risk',
  rule_code VARCHAR(128) NULL,
  description TEXT NULL,
  severity VARCHAR(32) NOT NULL DEFAULT 'soft',
  condition_json JSON NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_rer_bank ON risk_exception_rules (bank_id);

CREATE TABLE IF NOT EXISTS matching_engine_config (
  id VARCHAR(64) NOT NULL DEFAULT 'default',
  weights_json JSON NOT NULL,
  decision_thresholds_json JSON NOT NULL,
  updated_by CHAR(36) NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

INSERT INTO matching_engine_config (id, weights_json, decision_thresholds_json)
VALUES (
  'default',
  '{
    "income_mismatch": 25,
    "credit_mismatch": 20,
    "loan_amount_mismatch": 20,
    "employment_mismatch": 15,
    "loan_type_mismatch": 10,
    "age_mismatch": 18,
    "stability_mismatch": 10,
    "emi_capacity_mismatch": 12,
    "ltv_mismatch": 10,
    "critical_fail_penalty": 100
  }'::json,
  '{
    "eligible_min_probability": 70,
    "conditional_min_probability": 50
  }'::json
)
ON CONFLICT (id) DO NOTHING;
