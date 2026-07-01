-- Employee profile settings: OTP-backed password reset

CREATE TABLE IF NOT EXISTS employee_profile_otps (
  id CHAR(36) NOT NULL,
  employee_user_id CHAR(36) NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_employee_profile_otps_user ON employee_profile_otps (employee_user_id);
CREATE INDEX IF NOT EXISTS idx_employee_profile_otps_expires ON employee_profile_otps (expires_at);
