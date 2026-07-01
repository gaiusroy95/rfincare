-- Per-agent commission CSV import fields

ALTER TABLE agent_commission_config
  ADD COLUMN agent_code VARCHAR(64) NULL,
  ADD COLUMN agent_name VARCHAR(255) NULL,
  ADD COLUMN circular_title VARCHAR(255) NULL,
  ADD COLUMN circular_file_url TEXT NULL;

ALTER TABLE agent_commission_config
  ADD CONSTRAINT uq_agent_commission_agent_loan UNIQUE (agent_user_id, loan_type);
