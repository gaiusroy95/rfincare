-- Agent training / learning hub (videos, PDFs, presentations, circulars)

CREATE TABLE IF NOT EXISTS agent_learning_content (
  id CHAR(36) NOT NULL,
  content_type VARCHAR(32) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  duration_label VARCHAR(64) NULL,
  file_name VARCHAR(255) NULL,
  file_path TEXT NULL,
  file_url TEXT NULL,
  mime_type VARCHAR(128) NULL,
  video_url TEXT NULL,
  is_new BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0,
  uploaded_by CHAR(36) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS agent_learning_progress (
  id CHAR(36) NOT NULL,
  agent_user_id CHAR(36) NOT NULL,
  content_id CHAR(36) NOT NULL,
  progress_percent INT NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT uq_agent_learning_progress UNIQUE (agent_user_id, content_id)
);
