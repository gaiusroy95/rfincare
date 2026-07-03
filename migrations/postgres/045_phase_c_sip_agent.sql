-- Phase C: MF SIP orders + agent attribution on leads

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS sourced_agent_code VARCHAR(32) NULL;

CREATE INDEX IF NOT EXISTS idx_marketing_leads_sourced_agent
  ON marketing_leads (sourced_agent_code, created_at DESC);

CREATE TABLE IF NOT EXISTS mutual_fund_sip_orders (
  id CHAR(36) NOT NULL PRIMARY KEY,
  public_token VARCHAR(72) NOT NULL UNIQUE,
  mutual_fund_id CHAR(36) NOT NULL REFERENCES mutual_funds(id) ON DELETE CASCADE,
  marketing_lead_id CHAR(36) NULL,
  customer_name VARCHAR(255) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  customer_phone VARCHAR(32) NOT NULL,
  sip_amount DECIMAL(14, 2) NOT NULL,
  sip_day INT NOT NULL DEFAULT 1,
  tenure_years INT NULL,
  sourced_agent_code VARCHAR(32) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'created',
  invest_url TEXT NULL,
  external_reference VARCHAR(255) NULL,
  demographic_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mf_sip_orders_fund ON mutual_fund_sip_orders (mutual_fund_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mf_sip_orders_agent ON mutual_fund_sip_orders (sourced_agent_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mf_sip_orders_email ON mutual_fund_sip_orders (customer_email, created_at DESC);
