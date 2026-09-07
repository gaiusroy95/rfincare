-- Referral Attribution & Reward Engine

CREATE TABLE IF NOT EXISTS referral_settings (
  id VARCHAR(32) NOT NULL DEFAULT 'default',
  attribution_window_days INTEGER NOT NULL DEFAULT 90,
  first_touch_policy VARCHAR(32) NOT NULL DEFAULT 'first_valid_wins',
  existing_customer_policy VARCHAR(32) NOT NULL DEFAULT 'retain_original',
  customer_reward_type VARCHAR(16) NOT NULL DEFAULT 'fixed',
  customer_reward_amount NUMERIC(14, 2) NOT NULL DEFAULT 1000,
  customer_reward_min_disbursement NUMERIC(14, 2) NOT NULL DEFAULT 200000,
  customer_reward_trigger VARCHAR(32) NOT NULL DEFAULT 'disbursement',
  customer_reward_max_per_month INTEGER NOT NULL DEFAULT 10,
  agent_commission_tds_rate NUMERIC(8, 4) NOT NULL DEFAULT 0.10,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

INSERT INTO referral_settings (id) VALUES ('default')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS referral_clicks (
  id CHAR(36) NOT NULL PRIMARY KEY,
  referral_code VARCHAR(64) NOT NULL,
  program VARCHAR(16) NOT NULL,
  referrer_user_id CHAR(36) NULL,
  landing_url TEXT NULL,
  source_url TEXT NULL,
  utm_source VARCHAR(128) NULL,
  utm_medium VARCHAR(128) NULL,
  utm_campaign VARCHAR(128) NULL,
  ip_hash VARCHAR(128) NULL,
  device_ref VARCHAR(255) NULL,
  session_token VARCHAR(64) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_referral_clicks_code_created
  ON referral_clicks (referral_code, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_referral_clicks_session
  ON referral_clicks (session_token);

CREATE TABLE IF NOT EXISTS referral_attributions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  public_id VARCHAR(32) NOT NULL,
  referral_type VARCHAR(16) NOT NULL,
  referrer_user_id CHAR(36) NOT NULL,
  referrer_code VARCHAR(64) NOT NULL,
  referred_user_id CHAR(36) NULL,
  lead_id CHAR(36) NULL,
  click_id CHAR(36) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'clicked',
  fraud_flag VARCHAR(64) NULL,
  fraud_notes TEXT NULL,
  landing_page VARCHAR(255) NULL,
  source_url TEXT NULL,
  utm_source VARCHAR(128) NULL,
  utm_medium VARCHAR(128) NULL,
  expires_at TIMESTAMPTZ NULL,
  registered_at TIMESTAMPTZ NULL,
  lead_created_at TIMESTAMPTZ NULL,
  application_started_at TIMESTAMPTZ NULL,
  submitted_at TIMESTAMPTZ NULL,
  approved_at TIMESTAMPTZ NULL,
  disbursed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_referral_attributions_public_id UNIQUE (public_id)
);

CREATE INDEX IF NOT EXISTS idx_referral_attr_referrer
  ON referral_attributions (referrer_user_id, referral_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_referral_attr_referred
  ON referral_attributions (referred_user_id);

CREATE INDEX IF NOT EXISTS idx_referral_attr_status
  ON referral_attributions (status, created_at DESC);

CREATE TABLE IF NOT EXISTS referral_transactions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  public_id VARCHAR(32) NOT NULL,
  attribution_id CHAR(36) NOT NULL,
  referral_type VARCHAR(16) NOT NULL,
  referrer_user_id CHAR(36) NOT NULL,
  referred_user_id CHAR(36) NULL,
  application_id CHAR(36) NULL,
  product VARCHAR(128) NULL,
  lender VARCHAR(255) NULL,
  disbursed_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  commission_rate NUMERIC(8, 4) NULL,
  commission_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  reward_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  tds_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  net_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  eligibility_status VARCHAR(32) NOT NULL DEFAULT 'pending',
  payment_status VARCHAR(32) NOT NULL DEFAULT 'pending_verification',
  paid_at TIMESTAMPTZ NULL,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_referral_transactions_public_id UNIQUE (public_id),
  CONSTRAINT uq_referral_transactions_app_type UNIQUE (application_id, referral_type)
);

CREATE INDEX IF NOT EXISTS idx_referral_txn_referrer
  ON referral_transactions (referrer_user_id, payment_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_referral_txn_payment
  ON referral_transactions (payment_status, created_at DESC);

CREATE TABLE IF NOT EXISTS referral_commission_rules (
  id CHAR(36) NOT NULL PRIMARY KEY,
  product VARCHAR(128) NULL,
  lender VARCHAR(255) NULL,
  agent_type VARCHAR(64) NULL,
  commission_type VARCHAR(16) NOT NULL DEFAULT 'percentage',
  commission_value NUMERIC(14, 4) NOT NULL DEFAULT 1.0,
  min_disbursement NUMERIC(14, 2) NOT NULL DEFAULT 100000,
  max_commission NUMERIC(14, 2) NULL,
  trigger_event VARCHAR(32) NOT NULL DEFAULT 'disbursement',
  tds_rate NUMERIC(8, 4) NOT NULL DEFAULT 0.10,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS referral_reward_rules (
  id CHAR(36) NOT NULL PRIMARY KEY,
  referral_type VARCHAR(16) NOT NULL DEFAULT 'customer',
  qualifying_event VARCHAR(32) NOT NULL DEFAULT 'disbursement',
  reward_type VARCHAR(16) NOT NULL DEFAULT 'fixed',
  reward_value NUMERIC(14, 2) NOT NULL DEFAULT 1000,
  min_disbursement NUMERIC(14, 2) NOT NULL DEFAULT 200000,
  max_rewards_per_month INTEGER NOT NULL DEFAULT 10,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO referral_commission_rules (
  id, product, commission_type, commission_value, min_disbursement, trigger_event, tds_rate, is_active
) VALUES (
  '00000000-0000-4000-8000-000000000001', NULL, 'percentage', 1.0, 100000, 'disbursement', 0.10, TRUE
) ON CONFLICT (id) DO NOTHING;

INSERT INTO referral_reward_rules (
  id, referral_type, qualifying_event, reward_type, reward_value, min_disbursement, max_rewards_per_month, is_active
) VALUES (
  '00000000-0000-4000-8000-000000000002', 'customer', 'disbursement', 'fixed', 1000, 200000, 10, TRUE
) ON CONFLICT (id) DO NOTHING;

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS referral_id CHAR(36) NULL;

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS referral_type VARCHAR(16) NULL;

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS referrer_id VARCHAR(64) NULL;

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS referred_at TIMESTAMPTZ NULL;

ALTER TABLE loan_applications
  ADD COLUMN IF NOT EXISTS referral_id CHAR(36) NULL;

ALTER TABLE loan_applications
  ADD COLUMN IF NOT EXISTS referral_type VARCHAR(16) NULL;

ALTER TABLE loan_applications
  ADD COLUMN IF NOT EXISTS referrer_id VARCHAR(64) NULL;

CREATE INDEX IF NOT EXISTS idx_user_profiles_referral_id
  ON user_profiles (referral_id);

CREATE INDEX IF NOT EXISTS idx_loan_applications_referral_id
  ON loan_applications (referral_id);
