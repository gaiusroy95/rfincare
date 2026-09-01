-- Lender policy bulk upload: lender codes + import job history

ALTER TABLE banks
  ADD COLUMN IF NOT EXISTS lender_code VARCHAR(64) NULL;

ALTER TABLE banks
  ADD COLUMN IF NOT EXISTS effective_from DATE NULL;

ALTER TABLE banks
  ADD COLUMN IF NOT EXISTS policy_source VARCHAR(255) NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_banks_lender_code
  ON banks (lender_code)
  WHERE lender_code IS NOT NULL AND TRIM(lender_code) <> '';

CREATE TABLE IF NOT EXISTS lender_policy_import_jobs (
  id CHAR(36) NOT NULL,
  file_name VARCHAR(512) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'validated',
  summary_json JSON NULL,
  preview_json JSON NULL,
  unsupported_sheets_json JSON NULL,
  sheet_payload_json JSON NULL,
  error_report_json JSON NULL,
  commit_result_json JSON NULL,
  created_by CHAR(36) NULL,
  committed_by CHAR(36) NULL,
  committed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_lender_policy_import_jobs_created
  ON lender_policy_import_jobs (created_at DESC);
