-- Employee learning (shares agent_learning_content with audience column)

ALTER TABLE agent_learning_content
  ADD COLUMN audience VARCHAR(16) NOT NULL DEFAULT 'agent',
  ADD COLUMN category_label VARCHAR(64) NULL;

CREATE TABLE IF NOT EXISTS employee_learning_progress (
  id CHAR(36) NOT NULL,
  employee_user_id CHAR(36) NOT NULL,
  content_id CHAR(36) NOT NULL,
  progress_percent INT NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT uq_employee_learning_progress UNIQUE (employee_user_id, content_id)
);
