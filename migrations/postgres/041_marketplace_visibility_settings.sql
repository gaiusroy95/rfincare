CREATE TABLE IF NOT EXISTS marketplace_visibility_settings (
  id VARCHAR(16) PRIMARY KEY,
  bank_marketplace_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  credit_card_marketplace_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  insurance_marketplace_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  mutual_fund_marketplace_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by CHAR(36) NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO marketplace_visibility_settings (
  id,
  bank_marketplace_enabled,
  credit_card_marketplace_enabled,
  insurance_marketplace_enabled,
  mutual_fund_marketplace_enabled
)
VALUES ('default', TRUE, TRUE, TRUE, TRUE)
ON CONFLICT (id) DO NOTHING;
