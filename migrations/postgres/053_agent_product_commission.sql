-- Agent commission ledger for non-loan products (insurance, MF SIP)

ALTER TABLE insurance_purchase_orders
  ADD COLUMN IF NOT EXISTS sourced_agent_code VARCHAR(32) NULL;

CREATE INDEX IF NOT EXISTS idx_insurance_purchase_orders_agent
  ON insurance_purchase_orders (sourced_agent_code, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_commission_ledger (
  id CHAR(36) NOT NULL PRIMARY KEY,
  agent_user_id CHAR(36) NOT NULL,
  source_type VARCHAR(32) NOT NULL,
  source_id CHAR(36) NOT NULL,
  product_type VARCHAR(64) NOT NULL,
  base_amount DECIMAL(15, 2) NOT NULL,
  commission_amount DECIMAL(15, 2) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_agent_commission_ledger_source UNIQUE (source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_commission_ledger_agent
  ON agent_commission_ledger (agent_user_id, created_at DESC);
