-- Agent ↔ employee hierarchy mapping and staff messaging with document attachments

CREATE TABLE IF NOT EXISTS agent_employee_hierarchy (
  id CHAR(36) NOT NULL,
  agent_user_id CHAR(36) NOT NULL,
  employee_user_id CHAR(36) NOT NULL,
  communication_email VARCHAR(255) NOT NULL,
  hierarchy_level INT NOT NULL DEFAULT 1,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT NULL,
  created_by CHAR(36) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT uq_agent_employee UNIQUE (agent_user_id, employee_user_id)
);

CREATE TABLE IF NOT EXISTS staff_messages (
  id CHAR(36) NOT NULL,
  thread_key VARCHAR(128) NOT NULL,
  application_id CHAR(36) NULL,
  sender_id CHAR(36) NOT NULL,
  recipient_id CHAR(36) NOT NULL,
  subject VARCHAR(255) NULL,
  body TEXT NOT NULL,
  channel VARCHAR(16) NOT NULL DEFAULT 'internal',
  email_to VARCHAR(255) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at TIMESTAMPTZ NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS staff_message_attachments (
  id CHAR(36) NOT NULL,
  message_id CHAR(36) NOT NULL,
  document_id CHAR(36) NULL,
  file_name VARCHAR(255) NULL,
  file_url TEXT NULL,
  document_type VARCHAR(64) NULL,
  mime_type VARCHAR(128) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);
