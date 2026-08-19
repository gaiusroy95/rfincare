import { getPool } from './pool.js';
import { isIgnorableEnsureError } from './schemaErrors.js';

let ensured = false;

/** Create learning tables/columns if migrations have not been applied. */
export async function ensureAgentLearningSchema() {
  if (ensured) return;
  const pool = getPool();

  const statements = [
    `CREATE TABLE IF NOT EXISTS agent_learning_content (
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
    )`,
    `ALTER TABLE agent_learning_content ADD COLUMN IF NOT EXISTS audience VARCHAR(16) NOT NULL DEFAULT 'agent'`,
    `ALTER TABLE agent_learning_content ADD COLUMN IF NOT EXISTS category_label VARCHAR(64) NULL`,
    `UPDATE agent_learning_content SET audience = 'agent' WHERE audience IS NULL OR TRIM(audience) = ''`,
    `CREATE TABLE IF NOT EXISTS agent_learning_progress (
      id CHAR(36) NOT NULL,
      agent_user_id CHAR(36) NOT NULL,
      content_id CHAR(36) NOT NULL,
      progress_percent INT NOT NULL DEFAULT 0,
      completed_at TIMESTAMPTZ NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      CONSTRAINT uq_agent_learning_progress UNIQUE (agent_user_id, content_id)
    )`,
    `CREATE TABLE IF NOT EXISTS employee_learning_progress (
      id CHAR(36) NOT NULL,
      employee_user_id CHAR(36) NOT NULL,
      content_id CHAR(36) NOT NULL,
      progress_percent INT NOT NULL DEFAULT 0,
      completed_at TIMESTAMPTZ NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      CONSTRAINT uq_employee_learning_progress UNIQUE (employee_user_id, content_id)
    )`,
  ];

  for (const sql of statements) {
    try {
      await pool.execute(sql);
    } catch (err) {
      if (!isIgnorableEnsureError(err)) throw err;
    }
  }

  ensured = true;
}
