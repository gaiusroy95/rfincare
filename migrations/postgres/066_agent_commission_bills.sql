-- Agent monthly commission bill submissions (raise bill workflow)

CREATE TABLE IF NOT EXISTS agent_commission_bills (
  id UUID PRIMARY KEY,
  agent_user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  gross_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  tds_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  net_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'submitted',
  notes TEXT NULL,
  report_snapshot JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_commission_bills_agent
  ON agent_commission_bills (agent_user_id, created_at DESC);
