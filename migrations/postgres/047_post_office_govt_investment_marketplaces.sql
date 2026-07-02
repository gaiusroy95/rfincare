-- Post Office Investment Products
CREATE TABLE IF NOT EXISTS post_office_products (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(128) NULL,
  description TEXT NULL,
  logo_url TEXT NULL,
  categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  interest_rate DECIMAL(6, 3) NULL,
  tenure_min_months INT NULL,
  tenure_max_months INT NULL,
  min_deposit_amount DECIMAL(14, 2) NULL,
  max_deposit_amount DECIMAL(16, 2) NULL,
  eligibility_text TEXT NULL,
  returns_summary TEXT NULL,
  tax_benefits_text TEXT NULL,
  calculator_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  calculator_type VARCHAR(32) NULL,
  compounding_frequency VARCHAR(16) NULL DEFAULT 'annual',
  apply_url TEXT NULL,
  features JSON NULL,
  highlights TEXT NULL,
  display_priority INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_post_office_products_status ON post_office_products (status);
CREATE INDEX IF NOT EXISTS idx_post_office_products_priority ON post_office_products (display_priority);
CREATE INDEX IF NOT EXISTS idx_post_office_products_categories ON post_office_products USING GIN (categories);

-- Government Schemes
CREATE TABLE IF NOT EXISTS government_schemes (
  id CHAR(36) NOT NULL PRIMARY KEY,
  ministry_name VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(128) NULL,
  description TEXT NULL,
  logo_url TEXT NULL,
  categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  loan_amount_min DECIMAL(16, 2) NULL,
  loan_amount_max DECIMAL(16, 2) NULL,
  subsidy_percent DECIMAL(6, 3) NULL,
  interest_rate DECIMAL(6, 3) NULL,
  eligibility_text TEXT NULL,
  benefits_text TEXT NULL,
  application_url TEXT NULL,
  features JSON NULL,
  highlights TEXT NULL,
  display_priority INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_government_schemes_status ON government_schemes (status);
CREATE INDEX IF NOT EXISTS idx_government_schemes_priority ON government_schemes (display_priority);
CREATE INDEX IF NOT EXISTS idx_government_schemes_categories ON government_schemes USING GIN (categories);

-- Investment Marketplace (SGB, ETFs, Bonds, REIT, etc.)
CREATE TABLE IF NOT EXISTS investment_products (
  id CHAR(36) NOT NULL PRIMARY KEY,
  provider_name VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(128) NULL,
  description TEXT NULL,
  logo_url TEXT NULL,
  categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  returns_1y DECIMAL(8, 3) NULL,
  returns_3y DECIMAL(8, 3) NULL,
  risk_level VARCHAR(32) NULL,
  expense_ratio DECIMAL(6, 3) NULL,
  min_investment_amount DECIMAL(14, 2) NULL,
  tax_benefits_text TEXT NULL,
  maturity_tenure_text TEXT NULL,
  apply_url TEXT NULL,
  features JSON NULL,
  highlights TEXT NULL,
  display_priority INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_investment_products_status ON investment_products (status);
CREATE INDEX IF NOT EXISTS idx_investment_products_priority ON investment_products (display_priority);
CREATE INDEX IF NOT EXISTS idx_investment_products_categories ON investment_products USING GIN (categories);
