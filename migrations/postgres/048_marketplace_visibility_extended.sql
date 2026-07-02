ALTER TABLE marketplace_visibility_settings
  ADD COLUMN IF NOT EXISTS post_office_marketplace_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS government_schemes_marketplace_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS investment_marketplace_enabled BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE marketplace_visibility_settings
SET
  post_office_marketplace_enabled = COALESCE(post_office_marketplace_enabled, TRUE),
  government_schemes_marketplace_enabled = COALESCE(government_schemes_marketplace_enabled, TRUE),
  investment_marketplace_enabled = COALESCE(investment_marketplace_enabled, TRUE)
WHERE id = 'default';
