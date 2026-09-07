-- Lead TAT protection: Red Zone, reassignment history, richer SLA settings

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS red_zone BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS reassignment_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS previous_assigned_to CHAR(36) NULL;

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS contact_attempted_at TIMESTAMPTZ NULL;

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS contact_connected_at TIMESTAMPTZ NULL;

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS call_attempt_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS whatsapp_message_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS next_follow_up_at TIMESTAMPTZ NULL;

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS employee_remarks TEXT NULL;

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS loan_amount NUMERIC(14, 2) NULL;

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS employment_type VARCHAR(64) NULL;

ALTER TABLE marketing_leads
  ADD COLUMN IF NOT EXISTS location_city VARCHAR(128) NULL;

ALTER TABLE employee_onboarding
  ADD COLUMN IF NOT EXISTS missed_lead_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE lead_assignment_settings
  ADD COLUMN IF NOT EXISTS amber_warning_minutes INTEGER NOT NULL DEFAULT 15;

ALTER TABLE lead_assignment_settings
  ADD COLUMN IF NOT EXISTS red_zone_minutes INTEGER NOT NULL DEFAULT 20;

ALTER TABLE lead_assignment_settings
  ADD COLUMN IF NOT EXISTS auto_reassign_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE lead_assignment_settings
  ADD COLUMN IF NOT EXISTS max_reassignments INTEGER NOT NULL DEFAULT 5;

ALTER TABLE lead_assignment_settings
  ADD COLUMN IF NOT EXISTS notify_email_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE lead_assignment_settings
  ADD COLUMN IF NOT EXISTS notify_whatsapp_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS lead_assignment_history (
  id CHAR(36) NOT NULL PRIMARY KEY,
  lead_id CHAR(36) NOT NULL,
  from_employee_id CHAR(36) NULL,
  to_employee_id CHAR(36) NULL,
  assignment_rule VARCHAR(64) NULL,
  queue_position INTEGER NULL,
  reason VARCHAR(64) NULL,
  tat_minutes INTEGER NULL,
  meta_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lead_assignment_history_lead
  ON lead_assignment_history (lead_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketing_leads_red_zone
  ON marketing_leads (red_zone, first_contact_due_at)
  WHERE red_zone = TRUE OR first_contact_at IS NULL;
