-- MF SIP status lifecycle tracking

ALTER TABLE mutual_fund_sip_orders
  ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ NULL;

UPDATE mutual_fund_sip_orders
SET status_updated_at = COALESCE(updated_at, created_at)
WHERE status_updated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mf_sip_orders_status
  ON mutual_fund_sip_orders (status, status_updated_at DESC);
