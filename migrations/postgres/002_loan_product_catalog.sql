-- Platform loan product catalog (homepage cards, product pages, forms)
CREATE TABLE IF NOT EXISTS loan_product_catalog (
  id CHAR(36) NOT NULL,
  slug VARCHAR(64) NOT NULL,
  api_key VARCHAR(64) NOT NULL,
  label VARCHAR(255) NOT NULL,
  short_label VARCHAR(64) NULL,
  icon VARCHAR(64) NOT NULL DEFAULT 'Wallet',
  description TEXT NULL,
  interest_rate_min DECIMAL(5,2) NULL,
  interest_rate_max DECIMAL(5,2) NULL,
  features JSON NULL,
  color VARCHAR(32) NOT NULL DEFAULT 'var(--color-primary)',
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT uq_loan_product_catalog_slug UNIQUE (slug),
  CONSTRAINT uq_loan_product_catalog_api_key UNIQUE (api_key)
);
