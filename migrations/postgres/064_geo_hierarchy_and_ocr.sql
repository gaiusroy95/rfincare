-- Geo hierarchy (State → District → City → Tehsil → Village → PIN) + serviceability + OCR columns

CREATE TABLE IF NOT EXISTS geo_districts (
  id CHAR(36) NOT NULL,
  state_id CHAR(36) NOT NULL,
  name VARCHAR(128) NOT NULL,
  code VARCHAR(32) NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_geo_districts_state ON geo_districts (state_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_geo_districts_state_name
  ON geo_districts (state_id, LOWER(name));

CREATE TABLE IF NOT EXISTS geo_cities (
  id CHAR(36) NOT NULL,
  district_id CHAR(36) NOT NULL,
  name VARCHAR(128) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_geo_cities_district ON geo_cities (district_id);

CREATE TABLE IF NOT EXISTS geo_tehsils (
  id CHAR(36) NOT NULL,
  city_id CHAR(36) NULL,
  district_id CHAR(36) NOT NULL,
  name VARCHAR(128) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_geo_tehsils_district ON geo_tehsils (district_id);

CREATE TABLE IF NOT EXISTS geo_villages (
  id CHAR(36) NOT NULL,
  tehsil_id CHAR(36) NULL,
  district_id CHAR(36) NOT NULL,
  name VARCHAR(128) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_geo_villages_district ON geo_villages (district_id);

CREATE TABLE IF NOT EXISTS geo_pincodes (
  id CHAR(36) NOT NULL,
  pincode VARCHAR(10) NOT NULL,
  state_id CHAR(36) NULL,
  district_id CHAR(36) NULL,
  city_id CHAR(36) NULL,
  tehsil_id CHAR(36) NULL,
  village_id CHAR(36) NULL,
  locality VARCHAR(255) NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_geo_pincodes_pin ON geo_pincodes (pincode)
  WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_geo_pincodes_city ON geo_pincodes (city_id);
CREATE INDEX IF NOT EXISTS idx_geo_pincodes_district ON geo_pincodes (district_id);

CREATE TABLE IF NOT EXISTS lender_serviceability (
  id CHAR(36) NOT NULL,
  bank_id CHAR(36) NOT NULL,
  bank_product_id CHAR(36) NULL,
  level VARCHAR(32) NOT NULL DEFAULT 'pincode',
  ref_id CHAR(36) NULL,
  pincode VARCHAR(10) NULL,
  state_id CHAR(36) NULL,
  district_id CHAR(36) NULL,
  city_id CHAR(36) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'serviceable',
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_lender_svc_bank ON lender_serviceability (bank_id);
CREATE INDEX IF NOT EXISTS idx_lender_svc_pin ON lender_serviceability (pincode);

ALTER TABLE customer_documents
  ADD COLUMN IF NOT EXISTS ocr_status VARCHAR(32) NULL;

ALTER TABLE customer_documents
  ADD COLUMN IF NOT EXISTS ocr_engine VARCHAR(64) NULL;

ALTER TABLE customer_documents
  ADD COLUMN IF NOT EXISTS ocr_confidence NUMERIC(8, 4) NULL;

ALTER TABLE customer_documents
  ADD COLUMN IF NOT EXISTS ocr_payload JSON NULL;

ALTER TABLE customer_documents
  ADD COLUMN IF NOT EXISTS ocr_ran_at TIMESTAMPTZ NULL;

ALTER TABLE customer_documents
  ADD COLUMN IF NOT EXISTS ocr_suggestion VARCHAR(64) NULL;
