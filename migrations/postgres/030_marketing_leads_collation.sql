-- Legacy collation patch (no-op on PostgreSQL).

ALTER TABLE marketing_leads
  MODIFY full_name VARCHAR(255) NULL,
  MODIFY email VARCHAR(255) NOT NULL,
  MODIFY phone VARCHAR(32) NOT NULL,
  MODIFY loan_type VARCHAR(64) NULL,
  MODIFY source VARCHAR(64) NOT NULL DEFAULT 'website',
  MODIFY status VARCHAR(32) NOT NULL DEFAULT 'new',
  MODIFY session_key VARCHAR(128) NULL;

ALTER TABLE lead_otps
  MODIFY email VARCHAR(255) NULL,
  MODIFY phone VARCHAR(32) NULL,
  MODIFY otp_hash VARCHAR(64) NOT NULL,
  MODIFY purpose VARCHAR(32) NOT NULL DEFAULT 'lead_verify',
  MODIFY channel VARCHAR(16) NOT NULL DEFAULT 'sms';

ALTER TABLE application_form_drafts
  MODIFY session_key VARCHAR(128) NOT NULL,
  MODIFY loan_type VARCHAR(64) NULL,
  MODIFY loan_priority VARCHAR(32) NULL;
