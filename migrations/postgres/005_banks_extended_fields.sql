-- Extended bank fields for marketplace management UI

ALTER TABLE banks
  ADD COLUMN bank_type VARCHAR(32) NULL DEFAULT 'private',
  ADD COLUMN rating DECIMAL(4, 2) NULL DEFAULT NULL,
  ADD COLUMN reviews_count INT NULL DEFAULT 0,
  ADD COLUMN customers_served VARCHAR(64) NULL,
  ADD COLUMN partnership_duration VARCHAR(128) NULL,
  ADD COLUMN certifications JSON NULL;
