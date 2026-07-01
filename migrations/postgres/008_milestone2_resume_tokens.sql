-- Milestone 2: magic links to resume abandoned applications

CREATE TABLE IF NOT EXISTS application_resume_tokens (
  id CHAR(36) NOT NULL,
  session_key VARCHAR(128) NOT NULL,
  lead_id CHAR(36) NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);
