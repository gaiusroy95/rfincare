-- Direct Agent Onboarding: track resubmission of corrected documents
-- (client-facing stage "Documents Resubmitted — Re-verification").
ALTER TABLE agent_applications ADD COLUMN IF NOT EXISTS resubmitted_at TIMESTAMPTZ NULL;
