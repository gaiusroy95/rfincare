-- Homepage flash tiles (promotional carousel banners per marketplace category)

CREATE TABLE IF NOT EXISTS homepage_flash_tiles (
  id CHAR(36) NOT NULL,
  category VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  subtitle TEXT NULL,
  button_text VARCHAR(128) NOT NULL DEFAULT 'View',
  banner_image_url TEXT NULL,
  cta_url TEXT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  display_order INT NOT NULL DEFAULT 0,
  created_by CHAR(36) NULL,
  updated_by CHAR(36) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_flash_tiles_category_order
  ON homepage_flash_tiles (category, display_order ASC, created_at DESC);
