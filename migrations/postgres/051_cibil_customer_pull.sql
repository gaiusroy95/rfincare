-- Allow customer-initiated CIBIL pulls without a loan application

ALTER TABLE cibil_checks
  ALTER COLUMN application_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cibil_checks_customer_checked
  ON cibil_checks (customer_id, checked_at DESC);
