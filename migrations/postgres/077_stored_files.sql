-- Durable copy of uploaded files (customer documents, KYC, logos, learning files, generated PDFs).
-- Render / Cloud Run local disks are wiped on restart; reads fall back to this table.
CREATE TABLE IF NOT EXISTS stored_files (
  storage_key TEXT NOT NULL,
  mime_type VARCHAR(255) NULL,
  original_name VARCHAR(512) NULL,
  size_bytes INT NOT NULL DEFAULT 0,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (storage_key)
);
