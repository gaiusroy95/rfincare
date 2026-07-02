-- Add quote/proposal/payment-link fields for insurer-hosted payment flow

ALTER TABLE insurance_purchase_orders
  ADD COLUMN IF NOT EXISTS quote_id VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS proposal_id VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS proposal_number VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS insurer_payment_url TEXT NULL,
  ADD COLUMN IF NOT EXISTS insurer_payment_mode VARCHAR(16) NOT NULL DEFAULT 'redirect',
  ADD COLUMN IF NOT EXISTS policy_pdf_url TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_insurance_purchase_orders_proposal_id
  ON insurance_purchase_orders (proposal_id);

