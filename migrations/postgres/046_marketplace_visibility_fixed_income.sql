ALTER TABLE marketplace_visibility_settings
  ADD COLUMN IF NOT EXISTS fixed_income_marketplace_enabled BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE marketplace_visibility_settings
SET fixed_income_marketplace_enabled = TRUE
WHERE id = 'default' AND fixed_income_marketplace_enabled IS NULL;

