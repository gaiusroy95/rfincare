-- Expert consultation appointments (Talk to Expert)
CREATE TABLE IF NOT EXISTS expert_appointments (
  id VARCHAR(36) PRIMARY KEY,
  full_name VARCHAR(200) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  topic VARCHAR(120) NOT NULL,
  preferred_date DATE NOT NULL,
  preferred_time VARCHAR(16) NOT NULL,
  duration_minutes INT NOT NULL DEFAULT 30,
  notes TEXT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'scheduled',
  google_event_id VARCHAR(255) NULL,
  google_event_link TEXT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expert_appointments_starts_at ON expert_appointments (starts_at DESC);
CREATE INDEX IF NOT EXISTS idx_expert_appointments_email ON expert_appointments (email);
