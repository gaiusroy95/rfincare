-- Employee onboarding: PAN at create (photo uses user_profiles.avatar_url)

ALTER TABLE employee_onboarding
  ADD COLUMN IF NOT EXISTS pan_number VARCHAR(16) NULL;

ALTER TABLE employee_onboarding
  ADD COLUMN IF NOT EXISTS termination_reason VARCHAR(255) NULL;

ALTER TABLE employee_onboarding
  ADD COLUMN IF NOT EXISTS termination_remarks TEXT NULL;

ALTER TABLE employee_onboarding
  ADD COLUMN IF NOT EXISTS terminated_at TIMESTAMPTZ NULL;

ALTER TABLE employee_onboarding
  ADD COLUMN IF NOT EXISTS terminated_by CHAR(36) NULL;
