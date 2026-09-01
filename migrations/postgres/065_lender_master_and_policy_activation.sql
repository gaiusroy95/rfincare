-- Phase A lender master extensions + policy rule activation support

CREATE TABLE IF NOT EXISTS lender_branches (
  id CHAR(36) NOT NULL,
  bank_id CHAR(36) NOT NULL,
  branch_name VARCHAR(255) NOT NULL,
  branch_code VARCHAR(64) NULL,
  address_line1 VARCHAR(255) NULL,
  address_line2 VARCHAR(255) NULL,
  city VARCHAR(128) NULL,
  state VARCHAR(128) NULL,
  pincode VARCHAR(10) NULL,
  phone VARCHAR(32) NULL,
  email VARCHAR(255) NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_lender_branches_bank FOREIGN KEY (bank_id) REFERENCES banks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lender_branches_bank ON lender_branches (bank_id);
CREATE INDEX IF NOT EXISTS idx_lender_branches_pin ON lender_branches (pincode);

CREATE TABLE IF NOT EXISTS lender_contacts (
  id CHAR(36) NOT NULL,
  bank_id CHAR(36) NOT NULL,
  branch_id CHAR(36) NULL,
  contact_name VARCHAR(255) NOT NULL,
  role_title VARCHAR(128) NULL,
  department VARCHAR(128) NULL,
  email VARCHAR(255) NULL,
  phone VARCHAR(32) NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_lender_contacts_bank FOREIGN KEY (bank_id) REFERENCES banks(id) ON DELETE CASCADE,
  CONSTRAINT fk_lender_contacts_branch FOREIGN KEY (branch_id) REFERENCES lender_branches(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_lender_contacts_bank ON lender_contacts (bank_id);
CREATE INDEX IF NOT EXISTS idx_lender_contacts_branch ON lender_contacts (branch_id);

-- Fast lookup: which rules belong to live published policies
CREATE INDEX IF NOT EXISTS idx_er_version_active
  ON eligibility_rules (version_id, is_active)
  WHERE version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ppv_bank_product_active
  ON product_policy_versions (bank_id, bank_product_id, status);
