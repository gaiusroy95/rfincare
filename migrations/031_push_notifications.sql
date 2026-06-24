CREATE TABLE IF NOT EXISTS push_device_tokens (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  role VARCHAR(32) NOT NULL,
  expo_push_token VARCHAR(255) NOT NULL,
  platform VARCHAR(16) NULL,
  app_variant VARCHAR(32) NOT NULL DEFAULT 'customer',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_expo_push_token (expo_push_token),
  KEY idx_push_user (user_id, is_active)
);
