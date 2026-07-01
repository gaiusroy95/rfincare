-- Credit card marketplace: categories and structured comparison attributes

ALTER TABLE credit_cards
  ADD COLUMN IF NOT EXISTS categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS reward_points TEXT NULL,
  ADD COLUMN IF NOT EXISTS lounge_access BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS lounge_access_details TEXT NULL,
  ADD COLUMN IF NOT EXISTS fuel_surcharge_waiver BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS movie_benefits BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS movie_benefits_details TEXT NULL,
  ADD COLUMN IF NOT EXISTS dining_benefits BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS dining_benefits_details TEXT NULL,
  ADD COLUMN IF NOT EXISTS insurance_cover BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS insurance_cover_details TEXT NULL,
  ADD COLUMN IF NOT EXISTS forex_charges VARCHAR(128) NULL,
  ADD COLUMN IF NOT EXISTS emi_conversion BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS emi_conversion_details TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_credit_cards_categories ON credit_cards USING GIN (categories);
