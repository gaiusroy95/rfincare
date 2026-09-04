-- Lender geo policy versions + bank-level coverage (INCLUDE/EXCLUDE/CONDITIONAL/BRANCH_DEPENDENT)
-- Go-live hierarchy: State → District → Tehsil → PIN. Bank-level (all products share coverage).

CREATE TABLE IF NOT EXISTS lender_geo_policy_versions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  version_label VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  change_reason TEXT NULL,
  effective_from DATE NULL,
  effective_to DATE NULL,
  source_job_id CHAR(36) NULL,
  uploaded_by CHAR(36) NULL,
  approved_by CHAR(36) NULL,
  approved_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lender_geo_policy_versions_status
  ON lender_geo_policy_versions (status);

CREATE TABLE IF NOT EXISTS lender_geo_coverage (
  id CHAR(36) NOT NULL PRIMARY KEY,
  version_id CHAR(36) NOT NULL,
  bank_id CHAR(36) NOT NULL,
  geo_level VARCHAR(32) NOT NULL DEFAULT 'pincode',
  state_id CHAR(36) NULL,
  state_name VARCHAR(120) NULL,
  district_id CHAR(36) NULL,
  district_name VARCHAR(120) NULL,
  tehsil_id CHAR(36) NULL,
  tehsil_name VARCHAR(120) NULL,
  pincode VARCHAR(10) NULL,
  coverage_type VARCHAR(32) NOT NULL DEFAULT 'INCLUDE',
  branch_id CHAR(36) NULL,
  branch_code VARCHAR(64) NULL,
  radius_km NUMERIC(10, 2) NULL,
  condition_json JSONB NULL,
  remarks TEXT NULL,
  priority INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lender_geo_coverage_version
  ON lender_geo_coverage (version_id);
CREATE INDEX IF NOT EXISTS idx_lender_geo_coverage_bank
  ON lender_geo_coverage (bank_id);
CREATE INDEX IF NOT EXISTS idx_lender_geo_coverage_pin
  ON lender_geo_coverage (pincode);
CREATE INDEX IF NOT EXISTS idx_lender_geo_coverage_district
  ON lender_geo_coverage (district_name);
