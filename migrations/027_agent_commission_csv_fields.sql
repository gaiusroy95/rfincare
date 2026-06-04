-- Per-agent commission CSV import fields

ALTER TABLE agent_commission_config
  ADD COLUMN agent_code VARCHAR(64) NULL AFTER agent_user_id,
  ADD COLUMN agent_name VARCHAR(255) NULL AFTER agent_code,
  ADD COLUMN circular_title VARCHAR(255) NULL AFTER effective_to,
  ADD COLUMN circular_file_url TEXT NULL AFTER circular_title;

ALTER TABLE agent_commission_config
  ADD UNIQUE KEY uq_agent_commission_agent_loan (agent_user_id, loan_type);
