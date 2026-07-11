-- Customer financial goal planner
CREATE TABLE IF NOT EXISTS customer_financial_goals (
  id VARCHAR(36) PRIMARY KEY,
  customer_id VARCHAR(36) NOT NULL,
  label VARCHAR(120) NOT NULL,
  target_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  current_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  target_date DATE NULL,
  notes TEXT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_financial_goals_customer
  ON customer_financial_goals (customer_id, sort_order ASC, created_at ASC);
