-- Legacy collation patch (no-op on PostgreSQL).

ALTER TABLE auth_users
  MODIFY email VARCHAR(320) NOT NULL;

ALTER TABLE user_profiles
  MODIFY email VARCHAR(320) NOT NULL,
  MODIFY full_name VARCHAR(255) NULL,
  MODIFY phone VARCHAR(32) NULL,
  MODIFY role VARCHAR(32) NOT NULL DEFAULT 'customer',
  MODIFY account_status VARCHAR(32) NOT NULL DEFAULT 'active',
  MODIFY onboarding_status VARCHAR(64) NULL;

ALTER TABLE agent_onboarding
  MODIFY username VARCHAR(128) NOT NULL,
  MODIFY agent_name VARCHAR(255) NOT NULL,
  MODIFY agent_code VARCHAR(64) NOT NULL,
  MODIFY email VARCHAR(320) NOT NULL,
  MODIFY mobile_number VARCHAR(32) NOT NULL,
  MODIFY account_number VARCHAR(64) NOT NULL,
  MODIFY bank_name VARCHAR(255) NOT NULL,
  MODIFY ifsc_code VARCHAR(32) NOT NULL,
  MODIFY onboarding_status VARCHAR(32) NOT NULL DEFAULT 'pending';

ALTER TABLE employee_onboarding
  MODIFY username VARCHAR(128) NOT NULL,
  MODIFY employee_name VARCHAR(255) NOT NULL,
  MODIFY employee_code VARCHAR(64) NOT NULL,
  MODIFY email VARCHAR(320) NOT NULL,
  MODIFY mobile_number VARCHAR(32) NOT NULL,
  MODIFY account_number VARCHAR(64) NOT NULL,
  MODIFY bank_name VARCHAR(255) NOT NULL,
  MODIFY ifsc_code VARCHAR(32) NOT NULL,
  MODIFY onboarding_status VARCHAR(32) NOT NULL DEFAULT 'pending';
