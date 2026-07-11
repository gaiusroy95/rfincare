-- Customer ↔ support live chat threads
CREATE TABLE IF NOT EXISTS customer_support_messages (
  id VARCHAR(36) PRIMARY KEY,
  customer_id VARCHAR(36) NOT NULL,
  sender_role VARCHAR(16) NOT NULL,
  sender_id VARCHAR(36) NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_support_messages_customer_created
  ON customer_support_messages (customer_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_customer_support_messages_created
  ON customer_support_messages (created_at DESC);
