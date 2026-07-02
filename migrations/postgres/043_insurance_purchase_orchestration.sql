-- Insurance purchase orchestration: provider configs, purchase orders, events

ALTER TABLE insurance_products
  ADD COLUMN IF NOT EXISTS purchase_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS purchase_mode VARCHAR(16) NOT NULL DEFAULT 'redirect',
  ADD COLUMN IF NOT EXISTS insurer_provider_code VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS insurer_product_code VARCHAR(128) NULL,
  ADD COLUMN IF NOT EXISTS insurer_plan_code VARCHAR(128) NULL,
  ADD COLUMN IF NOT EXISTS payment_account_code VARCHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS demographic_mapping JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS insurance_provider_configs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  provider_code VARCHAR(64) NOT NULL UNIQUE,
  provider_name VARCHAR(255) NOT NULL,
  integration_mode VARCHAR(32) NOT NULL DEFAULT 'generic_api',
  base_url TEXT NULL,
  auth_type VARCHAR(32) NOT NULL DEFAULT 'bearer',
  api_key TEXT NULL,
  api_secret TEXT NULL,
  webhook_secret TEXT NULL,
  payment_account_code VARCHAR(64) NULL,
  request_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS insurance_purchase_orders (
  id CHAR(36) NOT NULL PRIMARY KEY,
  public_token VARCHAR(72) NOT NULL UNIQUE,
  insurance_product_id CHAR(36) NOT NULL REFERENCES insurance_products(id) ON DELETE CASCADE,
  insurer_provider_code VARCHAR(64) NULL,
  insurer_product_code VARCHAR(128) NULL,
  insurer_plan_code VARCHAR(128) NULL,
  customer_name VARCHAR(255) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  customer_phone VARCHAR(32) NOT NULL,
  demographic_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  pricing_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  payment_amount DECIMAL(14, 2) NOT NULL,
  payment_currency VARCHAR(8) NOT NULL DEFAULT 'INR',
  payment_provider VARCHAR(32) NOT NULL DEFAULT 'razorpay',
  payment_account_code VARCHAR(64) NULL,
  payment_status VARCHAR(32) NOT NULL DEFAULT 'created',
  purchase_mode VARCHAR(16) NOT NULL DEFAULT 'api',
  insurer_push_status VARCHAR(32) NOT NULL DEFAULT 'not_started',
  razorpay_order_id VARCHAR(128) NULL,
  razorpay_payment_id VARCHAR(128) NULL,
  razorpay_signature VARCHAR(255) NULL,
  paid_at TIMESTAMPTZ NULL,
  insurer_reference_id VARCHAR(255) NULL,
  insurer_policy_number VARCHAR(255) NULL,
  insurer_response_summary TEXT NULL,
  failure_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS insurance_purchase_events (
  id CHAR(36) NOT NULL PRIMARY KEY,
  purchase_order_id CHAR(36) NOT NULL REFERENCES insurance_purchase_orders(id) ON DELETE CASCADE,
  event_type VARCHAR(64) NOT NULL,
  event_status VARCHAR(32) NOT NULL DEFAULT 'info',
  actor_type VARCHAR(32) NOT NULL DEFAULT 'system',
  request_payload JSONB NULL,
  response_payload JSONB NULL,
  message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_insurance_products_purchase_enabled
  ON insurance_products (purchase_enabled, purchase_mode, insurer_provider_code);

CREATE INDEX IF NOT EXISTS idx_insurance_provider_configs_code
  ON insurance_provider_configs (provider_code, status);

CREATE INDEX IF NOT EXISTS idx_insurance_purchase_orders_product
  ON insurance_purchase_orders (insurance_product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_insurance_purchase_orders_payment
  ON insurance_purchase_orders (payment_status, insurer_push_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_insurance_purchase_orders_razorpay_order
  ON insurance_purchase_orders (razorpay_order_id);

CREATE INDEX IF NOT EXISTS idx_insurance_purchase_events_order
  ON insurance_purchase_events (purchase_order_id, created_at DESC);
