-- Employee-initiated standalone CIBIL checks (no linked customer account)

ALTER TABLE cibil_checks
  ALTER COLUMN customer_id DROP NOT NULL;
