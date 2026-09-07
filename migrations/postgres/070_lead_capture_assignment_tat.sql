-- Lead Capture, Round-Robin Assignment, TAT & Contact Timeline

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ NULL;

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS first_contact_due_at TIMESTAMPTZ NULL;

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS first_contact_at TIMESTAMPTZ NULL;

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS first_contact_channel VARCHAR(32) NULL;

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS first_contact_by CHAR(36) NULL;

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS tat_minutes INTEGER NULL;

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS tat_status VARCHAR(32) NULL;

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS assignment_method VARCHAR(32) NULL;

CREATE INDEX IF NOT EXISTS idx_marketing_leads_assigned_to_created
  ON marketing_leads (assigned_to, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketing_leads_first_contact_due
  ON marketing_leads (first_contact_due_at)
  WHERE first_contact_at IS NULL;

CREATE TABLE IF NOT EXISTS lead_assignment_settings (
  id VARCHAR(32) NOT NULL DEFAULT 'default',
  first_contact_tat_minutes INTEGER NOT NULL DEFAULT 20,
  round_robin_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_assigned_employee_id CHAR(36) NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

INSERT INTO lead_assignment_settings (id) VALUES ('default')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS lead_activities (
  id CHAR(36) NOT NULL PRIMARY KEY,
  lead_id CHAR(36) NOT NULL,
  actor_user_id CHAR(36) NULL,
  activity_type VARCHAR(32) NOT NULL,
  channel VARCHAR(32) NULL,
  notes TEXT NULL,
  meta_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lead_activities_lead_created
  ON lead_activities (lead_id, created_at DESC);

ALTER TABLE employee_onboarding
  ADD COLUMN IF NOT EXISTS lead_available BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE employee_onboarding
  ADD COLUMN IF NOT EXISTS lead_level INTEGER NULL;
