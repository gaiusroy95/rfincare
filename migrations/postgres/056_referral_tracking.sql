-- Unique referral codes for agent + customer programs, plus lead attribution.

CREATE TABLE IF NOT EXISTS referral_codes (
  id CHAR(36) NOT NULL PRIMARY KEY,
  owner_user_id CHAR(36) NOT NULL,
  owner_role VARCHAR(32) NOT NULL,
  program VARCHAR(16) NOT NULL,
  code VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_referral_codes_code UNIQUE (code),
  CONSTRAINT uq_referral_codes_owner_program UNIQUE (owner_user_id, program)
);

CREATE INDEX IF NOT EXISTS idx_referral_codes_owner
  ON referral_codes (owner_user_id, program);

CREATE TABLE IF NOT EXISTS referral_invites (
  id CHAR(36) NOT NULL PRIMARY KEY,
  referral_code_id CHAR(36) NOT NULL,
  referrer_user_id CHAR(36) NOT NULL,
  program VARCHAR(16) NOT NULL,
  referred_name VARCHAR(255) NULL,
  referred_email VARCHAR(255) NULL,
  referred_phone VARCHAR(32) NULL,
  channel VARCHAR(32) NULL,
  lead_id CHAR(36) NULL,
  converted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_referral_invites_referrer
  ON referral_invites (referrer_user_id, program, created_at DESC);

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS referral_code VARCHAR(64) NULL;

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS referral_program VARCHAR(16) NULL;

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS referred_by_user_id CHAR(36) NULL;

CREATE INDEX IF NOT EXISTS idx_marketing_leads_referral_code
  ON marketing_leads (referral_code, created_at DESC);
