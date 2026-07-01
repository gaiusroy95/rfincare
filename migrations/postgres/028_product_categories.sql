-- Product category taxonomy (Personal Loan, School Loan, etc.)
CREATE TABLE IF NOT EXISTS product_categories (
  id CHAR(36) NOT NULL,
  slug VARCHAR(64) NOT NULL,
  label VARCHAR(255) NOT NULL,
  parent_loan_type VARCHAR(64) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT uq_product_categories_slug UNIQUE (slug)
);

ALTER TABLE loan_product_catalog
  ADD COLUMN category_id CHAR(36) NULL,
  ADD COLUMN bank_id CHAR(36) NULL,
  ADD COLUMN bank_product_id CHAR(36) NULL;
