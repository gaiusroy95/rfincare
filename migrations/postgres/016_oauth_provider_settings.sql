-- Admin-managed OAuth provider credentials and global OAuth settings

CREATE TABLE IF NOT EXISTS oauth_global_settings (
  id VARCHAR(32) NOT NULL DEFAULT 'default',
  api_public_base_url VARCHAR(512) NULL,
  frontend_callback_urls_json JSON NULL,
  require_applied_customer_email BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by CHAR(36) NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS oauth_provider_config (
  provider VARCHAR(32) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  client_id VARCHAR(512) NULL,
  client_secret VARCHAR(512) NULL,
  redirect_uri VARCHAR(512) NULL,
  updated_by CHAR(36) NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider)
);

INSERT INTO oauth_global_settings (id, require_applied_customer_email, frontend_callback_urls_json)
VALUES ('default', 1, JSON_ARRAY('http://127.0.0.1:4028/oauth/callback'))
ON CONFLICT (id) DO NOTHING;

INSERT INTO oauth_provider_config (provider, enabled) VALUES
  ('google', 0),
  ('microsoft', 0),
  ('apple', 0)
ON CONFLICT (provider) DO NOTHING;
