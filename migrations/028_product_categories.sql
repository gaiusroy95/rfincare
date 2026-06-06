-- Product category taxonomy (Personal Loan, School Loan, etc.)
CREATE TABLE IF NOT EXISTS product_categories (
  id CHAR(36) NOT NULL,
  slug VARCHAR(64) NOT NULL,
  label VARCHAR(255) NOT NULL,
  parent_loan_type VARCHAR(64) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_product_categories_slug (slug),
  KEY idx_product_categories_active (is_active, sort_order)
);

ALTER TABLE loan_product_catalog
  ADD COLUMN category_id CHAR(36) NULL AFTER api_key,
  ADD COLUMN bank_id CHAR(36) NULL AFTER category_id,
  ADD COLUMN bank_product_id CHAR(36) NULL AFTER bank_id;
