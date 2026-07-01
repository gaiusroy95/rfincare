CREATE TABLE IF NOT EXISTS document_requirements (
  id CHAR(36) NOT NULL,
  bank_id CHAR(36) NULL,
  product_type VARCHAR(128) NULL,
  loan_type VARCHAR(64) NULL,
  document_type VARCHAR(128) NOT NULL,
  title VARCHAR(255) NOT NULL,
  subtitle TEXT NULL,
  allowed_file_types_json JSON NULL,
  is_required BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by CHAR(36) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);
