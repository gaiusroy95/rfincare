ALTER TABLE otp_provider_settings
  ADD COLUMN IF NOT EXISTS whatsapp_provider VARCHAR(32) NOT NULL DEFAULT 'console',
  ADD COLUMN IF NOT EXISTS require_whatsapp_otp BOOLEAN NOT NULL DEFAULT FALSE;
