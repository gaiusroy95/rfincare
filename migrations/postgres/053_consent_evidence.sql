-- TRAI / telecom consent evidence for homepage CIBIL and similar public forms.
-- Also auto-created at runtime by ensureConsentEvidenceSchema().

CREATE TABLE IF NOT EXISTS consent_evidence (
  id CHAR(36) PRIMARY KEY,
  consent_record TEXT NOT NULL,
  consent_date VARCHAR(64) NOT NULL,
  consent_date_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consent_source VARCHAR(128) NOT NULL,
  consent_wording TEXT NOT NULL,
  customer_number VARCHAR(32) NOT NULL,
  product_purpose TEXT NOT NULL,
  relationship VARCHAR(128) NOT NULL,
  relationship_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tm_details TEXT NULL,
  dlt_record TEXT NULL,
  lead_id CHAR(36) NULL,
  ip_address TEXT NULL,
  user_agent TEXT NULL,
  metadata JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consent_evidence_lead_id ON consent_evidence (lead_id);
CREATE INDEX IF NOT EXISTS idx_consent_evidence_source ON consent_evidence (consent_source);
CREATE INDEX IF NOT EXISTS idx_consent_evidence_created ON consent_evidence (created_at DESC);
