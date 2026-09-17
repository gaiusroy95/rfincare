-- Marketing materials metadata for campaign assets
ALTER TABLE agent_learning_content ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT NULL;
ALTER TABLE agent_learning_content ADD COLUMN IF NOT EXISTS thumbnail_url TEXT NULL;
