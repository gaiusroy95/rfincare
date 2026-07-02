-- Insurance companies registry (separate from banks/loan partners and API provider configs)

CREATE TABLE IF NOT EXISTS insurance_insurers (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(128) NULL,
  logo_url TEXT NULL,
  website_url TEXT NULL,
  display_priority INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_insurance_insurers_name_lower
  ON insurance_insurers (LOWER(name));

CREATE INDEX IF NOT EXISTS idx_insurance_insurers_status
  ON insurance_insurers (status);

CREATE INDEX IF NOT EXISTS idx_insurance_insurers_priority
  ON insurance_insurers (display_priority DESC);
