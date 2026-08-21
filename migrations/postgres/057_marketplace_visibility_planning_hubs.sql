ALTER TABLE marketplace_visibility_settings
  ADD COLUMN IF NOT EXISTS retirement_planning_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS wealth_management_enabled BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE marketplace_visibility_settings
SET
  retirement_planning_enabled = COALESCE(retirement_planning_enabled, TRUE),
  wealth_management_enabled = COALESCE(wealth_management_enabled, TRUE)
WHERE id = 'default';
