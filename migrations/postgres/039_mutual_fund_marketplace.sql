-- Mutual fund marketplace

CREATE TABLE IF NOT EXISTS mutual_funds (
  id CHAR(36) NOT NULL PRIMARY KEY,
  amc_id CHAR(36) NULL,
  amc_name VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(128) NULL,
  description TEXT NULL,
  logo_url TEXT NULL,
  categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  returns_1y DECIMAL(8, 3) NULL,
  returns_3y DECIMAL(8, 3) NULL,
  returns_5y DECIMAL(8, 3) NULL,
  risk_level VARCHAR(32) NULL,
  expense_ratio DECIMAL(6, 3) NULL,
  fund_manager VARCHAR(255) NULL,
  aum_crores DECIMAL(14, 2) NULL,
  rating DECIMAL(2, 1) NULL,
  min_sip_amount DECIMAL(12, 2) NULL,
  min_lumpsum_amount DECIMAL(14, 2) NULL,
  supports_sip BOOLEAN NOT NULL DEFAULT TRUE,
  supports_lumpsum BOOLEAN NOT NULL DEFAULT TRUE,
  invest_url TEXT NULL,
  features JSON NULL,
  highlights TEXT NULL,
  display_priority INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mutual_funds_status ON mutual_funds (status);
CREATE INDEX IF NOT EXISTS idx_mutual_funds_priority ON mutual_funds (display_priority);
CREATE INDEX IF NOT EXISTS idx_mutual_funds_categories ON mutual_funds USING GIN (categories);
CREATE INDEX IF NOT EXISTS idx_mutual_funds_rating ON mutual_funds (rating);
CREATE INDEX IF NOT EXISTS idx_mutual_funds_risk ON mutual_funds (risk_level);
