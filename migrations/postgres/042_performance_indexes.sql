-- Hot-path indexes for list queries at scale (loan applications, bank products, documents)

CREATE INDEX IF NOT EXISTS idx_loan_applications_created_at
  ON loan_applications (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_loan_applications_customer_id
  ON loan_applications (customer_id);

CREATE INDEX IF NOT EXISTS idx_loan_applications_agent_id
  ON loan_applications (agent_id);

CREATE INDEX IF NOT EXISTS idx_loan_applications_status
  ON loan_applications (status);

CREATE INDEX IF NOT EXISTS idx_loan_applications_assigned_employee
  ON loan_applications (assigned_employee_id);

CREATE INDEX IF NOT EXISTS idx_bank_products_bank_active
  ON bank_products (bank_id, is_active);

CREATE INDEX IF NOT EXISTS idx_customer_documents_application_id
  ON customer_documents (application_id);
