import { getPool } from './pool.js';

let ensured = false;

export async function ensurePartnerRegistrationSchema(connOrPool) {
  if (ensured) return;
  const pool = connOrPool?.execute ? connOrPool : getPool();

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS partner_registrations (
      id CHAR(36) NOT NULL PRIMARY KEY,
      full_name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(32) NOT NULL,
      address_line1 VARCHAR(512) NULL,
      address_line2 VARCHAR(512) NULL,
      city VARCHAR(128) NULL,
      state VARCHAR(128) NULL,
      pin_code VARCHAR(16) NULL,
      pan_number VARCHAR(16) NULL,
      bank_name VARCHAR(255) NULL,
      account_number VARCHAR(64) NULL,
      branch_address VARCHAR(512) NULL,
      ifsc_code VARCHAR(32) NULL,
      photo_path VARCHAR(512) NULL,
      pan_card_path VARCHAR(512) NULL,
      cancelled_cheque_path VARCHAR(512) NULL,
      address_proof_path VARCHAR(512) NULL,
      registration_status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
      rejection_reason TEXT NULL,
      reviewed_by CHAR(36) NULL,
      reviewed_at DATETIME(3) NULL,
      approved_at DATETIME(3) NULL,
      approved_user_id CHAR(36) NULL,
      assigned_agent_code VARCHAR(64) NULL,
      financial_year VARCHAR(8) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_partner_registrations_email (email),
      INDEX idx_partner_registrations_status (registration_status),
      INDEX idx_partner_registrations_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Add pan_card_path for tables created before this column existed.
  try {
    await pool.execute(
      `ALTER TABLE partner_registrations ADD COLUMN pan_card_path VARCHAR(512) NULL AFTER photo_path`,
    );
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') throw err;
  }

  ensured = true;
}
