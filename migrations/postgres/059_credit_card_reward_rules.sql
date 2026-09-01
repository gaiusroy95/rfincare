-- CredLaxmi: structured reward rules for credit-card NAV savings engine
ALTER TABLE credit_cards
  ADD COLUMN IF NOT EXISTS reward_rules JSONB NULL,
  ADD COLUMN IF NOT EXISTS annual_fee_waiver_spend_threshold DECIMAL(14, 2) NULL;

COMMENT ON COLUMN credit_cards.reward_rules IS 'CredLaxmi reward rules JSON: fees, earn_rates, milestones, welcome, lounge';
COMMENT ON COLUMN credit_cards.annual_fee_waiver_spend_threshold IS 'Annual spend at/above which annual fee is waived (₹)';
