-- Fixed income marketplace: FD, corporate FD, NBFC FD, etc.

CREATE TABLE IF NOT EXISTS fixed_income_products (
  id CHAR(36) NOT NULL PRIMARY KEY,
  provider_id CHAR(36) NULL,
  provider_name VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(128) NULL,
  description TEXT NULL,
  logo_url TEXT NULL,
  categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  interest_rate DECIMAL(6, 3) NULL,
  interest_rate_min DECIMAL(6, 3) NULL,
  interest_rate_max DECIMAL(6, 3) NULL,
  lock_in_months INT NULL,
  premature_withdrawal BOOLEAN NOT NULL DEFAULT TRUE,
  monthly_interest BOOLEAN NOT NULL DEFAULT FALSE,
  quarterly_interest BOOLEAN NOT NULL DEFAULT TRUE,
  min_deposit_amount DECIMAL(14, 2) NULL,
  max_deposit_amount DECIMAL(16, 2) NULL,
  tenure_min_months INT NULL,
  tenure_max_months INT NULL,
  apply_url TEXT NULL,
  features JSON NULL,
  highlights TEXT NULL,
  display_priority INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fixed_income_products_status ON fixed_income_products (status);
CREATE INDEX IF NOT EXISTS idx_fixed_income_products_priority ON fixed_income_products (display_priority);
CREATE INDEX IF NOT EXISTS idx_fixed_income_products_categories ON fixed_income_products USING GIN (categories);
CREATE INDEX IF NOT EXISTS idx_fixed_income_products_rate ON fixed_income_products (interest_rate);
