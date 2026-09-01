-- Account proof file path when agent updates commission bank details

ALTER TABLE agent_onboarding
  ADD COLUMN IF NOT EXISTS account_proof_path TEXT NULL;
