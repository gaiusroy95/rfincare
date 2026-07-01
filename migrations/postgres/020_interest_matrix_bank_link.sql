ALTER TABLE interest_matrix_rates
  ADD COLUMN IF NOT EXISTS bank_id CHAR(36) NULL;

CREATE INDEX IF NOT EXISTS idx_interest_matrix_bank ON interest_matrix_rates (bank_id);
