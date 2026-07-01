-- Align string columns to utf8mb4_unicode_ci (fixes "Illegal mix of collations" on hosted MySQL).

ALTER TABLE loan_applications
  MODIFY status VARCHAR(32) NOT NULL DEFAULT 'draft',
  MODIFY status_notes TEXT,
  MODIFY review_notes TEXT,
  MODIFY rejection_reason TEXT,
  MODIFY eligibility_status VARCHAR(64) NULL,
  MODIFY application_number VARCHAR(64) NULL;

ALTER TABLE application_timeline
  MODIFY status VARCHAR(32) NOT NULL,
  MODIFY message TEXT;
