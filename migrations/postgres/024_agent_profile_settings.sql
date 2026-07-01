-- Agent profile settings: avatar + OTP-backed changes

ALTER TABLE user_profiles
  ADD COLUMN avatar_url VARCHAR(512) NULL;

CREATE TABLE IF NOT EXISTS agent_profile_otps (
  id CHAR(36) NOT NULL,
  agent_user_id CHAR(36) NOT NULL,
  purpose VARCHAR(48) NOT NULL,
  channel VARCHAR(16) NOT NULL,
  target_email VARCHAR(320) NULL,
  target_phone VARCHAR(32) NULL,
  otp_hash VARCHAR(64) NOT NULL,
  payload JSON NULL,
  verified_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);
