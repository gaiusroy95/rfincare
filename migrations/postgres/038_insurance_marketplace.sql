-- Insurance marketplace: life, health, and motor products with services

CREATE TABLE IF NOT EXISTS insurance_products (
  id CHAR(36) NOT NULL PRIMARY KEY,
  insurer_id CHAR(36) NULL,
  insurer_name VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(128) NULL,
  description TEXT NULL,
  logo_url TEXT NULL,
  segment VARCHAR(32) NOT NULL,
  categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  premium_from DECIMAL(14, 2) NULL,
  premium_to DECIMAL(14, 2) NULL,
  premium_unit VARCHAR(16) NOT NULL DEFAULT 'yearly',
  sum_insured_from DECIMAL(16, 2) NULL,
  sum_insured_to DECIMAL(16, 2) NULL,
  coverage_term_years INT NULL,
  waiting_period_days INT NULL,
  claim_settlement_ratio DECIMAL(5, 2) NULL,
  cashless_hospitals INT NULL,
  tax_benefit_80c BOOLEAN NOT NULL DEFAULT FALSE,
  tax_benefit_80d BOOLEAN NOT NULL DEFAULT FALSE,
  supports_new_policy BOOLEAN NOT NULL DEFAULT TRUE,
  supports_renewal BOOLEAN NOT NULL DEFAULT FALSE,
  supports_claim_assistance BOOLEAN NOT NULL DEFAULT FALSE,
  new_policy_url TEXT NULL,
  renewal_url TEXT NULL,
  claim_assistance_url TEXT NULL,
  features JSON NULL,
  benefits JSON NULL,
  highlights TEXT NULL,
  display_priority INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_insurance_products_status ON insurance_products (status);
CREATE INDEX IF NOT EXISTS idx_insurance_products_segment ON insurance_products (segment);
CREATE INDEX IF NOT EXISTS idx_insurance_products_priority ON insurance_products (display_priority);
CREATE INDEX IF NOT EXISTS idx_insurance_products_categories ON insurance_products USING GIN (categories);
