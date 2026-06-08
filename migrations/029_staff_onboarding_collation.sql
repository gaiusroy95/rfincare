-- Fix "Illegal mix of collations" on agent/employee onboarding (hosted MySQL defaults).

ALTER TABLE auth_users
  MODIFY email VARCHAR(320) NOT NULL COLLATE utf8mb4_unicode_ci;

ALTER TABLE user_profiles
  MODIFY email VARCHAR(320) NOT NULL COLLATE utf8mb4_unicode_ci,
  MODIFY full_name VARCHAR(255) NULL COLLATE utf8mb4_unicode_ci,
  MODIFY phone VARCHAR(32) NULL COLLATE utf8mb4_unicode_ci,
  MODIFY role VARCHAR(32) NOT NULL DEFAULT 'customer' COLLATE utf8mb4_unicode_ci,
  MODIFY account_status VARCHAR(32) NOT NULL DEFAULT 'active' COLLATE utf8mb4_unicode_ci,
  MODIFY onboarding_status VARCHAR(64) NULL COLLATE utf8mb4_unicode_ci;

ALTER TABLE agent_onboarding
  MODIFY username VARCHAR(128) NOT NULL COLLATE utf8mb4_unicode_ci,
  MODIFY agent_name VARCHAR(255) NOT NULL COLLATE utf8mb4_unicode_ci,
  MODIFY agent_code VARCHAR(64) NOT NULL COLLATE utf8mb4_unicode_ci,
  MODIFY email VARCHAR(320) NOT NULL COLLATE utf8mb4_unicode_ci,
  MODIFY mobile_number VARCHAR(32) NOT NULL COLLATE utf8mb4_unicode_ci,
  MODIFY account_number VARCHAR(64) NOT NULL COLLATE utf8mb4_unicode_ci,
  MODIFY bank_name VARCHAR(255) NOT NULL COLLATE utf8mb4_unicode_ci,
  MODIFY ifsc_code VARCHAR(32) NOT NULL COLLATE utf8mb4_unicode_ci,
  MODIFY onboarding_status VARCHAR(32) NOT NULL DEFAULT 'pending' COLLATE utf8mb4_unicode_ci;

ALTER TABLE employee_onboarding
  MODIFY username VARCHAR(128) NOT NULL COLLATE utf8mb4_unicode_ci,
  MODIFY employee_name VARCHAR(255) NOT NULL COLLATE utf8mb4_unicode_ci,
  MODIFY employee_code VARCHAR(64) NOT NULL COLLATE utf8mb4_unicode_ci,
  MODIFY email VARCHAR(320) NOT NULL COLLATE utf8mb4_unicode_ci,
  MODIFY mobile_number VARCHAR(32) NOT NULL COLLATE utf8mb4_unicode_ci,
  MODIFY account_number VARCHAR(64) NOT NULL COLLATE utf8mb4_unicode_ci,
  MODIFY bank_name VARCHAR(255) NOT NULL COLLATE utf8mb4_unicode_ci,
  MODIFY ifsc_code VARCHAR(32) NOT NULL COLLATE utf8mb4_unicode_ci,
  MODIFY onboarding_status VARCHAR(32) NOT NULL DEFAULT 'pending' COLLATE utf8mb4_unicode_ci;
