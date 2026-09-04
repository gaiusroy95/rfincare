import { getPool } from "../db/pool.js";
import { newId } from "./ids.js";
let schemaReady = false;
async function ensureLenderMasterSchema(pool = getPool()) {
  if (schemaReady) return;
  await pool.execute(`
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
      PRIMARY KEY (id)
    )
  `);
  await pool.execute(`
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
      PRIMARY KEY (id)
    )
  `);
  schemaReady = true;
}
async function listLenderBranches(bankId) {
  await ensureLenderMasterSchema();
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT * FROM lender_branches WHERE bank_id = :bank_id ORDER BY branch_name ASC`,
    { bank_id: bankId }
  );
  return rows;
}
async function createLenderBranch(bankId, data) {
  await ensureLenderMasterSchema();
  const pool = getPool();
  const id = newId();
  await pool.execute(
    `INSERT INTO lender_branches (
       id, bank_id, branch_name, branch_code, address_line1, address_line2,
       city, state, pincode, phone, email, is_active
     ) VALUES (
       :id, :bank_id, :branch_name, :branch_code, :address_line1, :address_line2,
       :city, :state, :pincode, :phone, :email, :is_active
     )`,
    {
      id,
      bank_id: bankId,
      branch_name: data.branchName,
      branch_code: data.branchCode || null,
      address_line1: data.addressLine1 || null,
      address_line2: data.addressLine2 || null,
      city: data.city || null,
      state: data.state || null,
      pincode: data.pincode || null,
      phone: data.phone || null,
      email: data.email || null,
      is_active: data.isActive !== false
    }
  );
  const [[row]] = await pool.execute(`SELECT * FROM lender_branches WHERE id = :id`, { id });
  return row;
}
async function updateLenderBranch(branchId, data) {
  await ensureLenderMasterSchema();
  const pool = getPool();
  await pool.execute(
    `UPDATE lender_branches SET
       branch_name = COALESCE(:branch_name, branch_name),
       branch_code = COALESCE(:branch_code, branch_code),
       address_line1 = COALESCE(:address_line1, address_line1),
       address_line2 = COALESCE(:address_line2, address_line2),
       city = COALESCE(:city, city),
       state = COALESCE(:state, state),
       pincode = COALESCE(:pincode, pincode),
       phone = COALESCE(:phone, phone),
       email = COALESCE(:email, email),
       is_active = COALESCE(:is_active, is_active),
       updated_at = NOW()
     WHERE id = :id`,
    {
      id: branchId,
      branch_name: data.branchName ?? null,
      branch_code: data.branchCode ?? null,
      address_line1: data.addressLine1 ?? null,
      address_line2: data.addressLine2 ?? null,
      city: data.city ?? null,
      state: data.state ?? null,
      pincode: data.pincode ?? null,
      phone: data.phone ?? null,
      email: data.email ?? null,
      is_active: data.isActive ?? null
    }
  );
  const [[row]] = await pool.execute(`SELECT * FROM lender_branches WHERE id = :id`, { id: branchId });
  return row;
}
async function deleteLenderBranch(branchId) {
  await ensureLenderMasterSchema();
  const pool = getPool();
  await pool.execute(`UPDATE lender_branches SET is_active = FALSE, updated_at = NOW() WHERE id = :id`, {
    id: branchId
  });
}
async function listLenderContacts(bankId) {
  await ensureLenderMasterSchema();
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT c.*, b.branch_name
     FROM lender_contacts c
     LEFT JOIN lender_branches b ON b.id = c.branch_id
     WHERE c.bank_id = :bank_id AND c.is_active = TRUE
     ORDER BY c.is_primary DESC, c.contact_name ASC`,
    { bank_id: bankId }
  );
  return rows;
}
async function createLenderContact(bankId, data) {
  await ensureLenderMasterSchema();
  const pool = getPool();
  const id = newId();
  if (data.isPrimary) {
    await pool.execute(
      `UPDATE lender_contacts SET is_primary = FALSE, updated_at = NOW() WHERE bank_id = :bank_id`,
      { bank_id: bankId }
    );
  }
  await pool.execute(
    `INSERT INTO lender_contacts (
       id, bank_id, branch_id, contact_name, role_title, department,
       email, phone, is_primary, is_active, notes
     ) VALUES (
       :id, :bank_id, :branch_id, :contact_name, :role_title, :department,
       :email, :phone, :is_primary, TRUE, :notes
     )`,
    {
      id,
      bank_id: bankId,
      branch_id: data.branchId || null,
      contact_name: data.contactName,
      role_title: data.roleTitle || null,
      department: data.department || null,
      email: data.email || null,
      phone: data.phone || null,
      is_primary: Boolean(data.isPrimary),
      notes: data.notes || null
    }
  );
  const [[row]] = await pool.execute(`SELECT * FROM lender_contacts WHERE id = :id`, { id });
  return row;
}
async function updateLenderContact(contactId, data) {
  await ensureLenderMasterSchema();
  const pool = getPool();
  const [[existing]] = await pool.execute(`SELECT bank_id FROM lender_contacts WHERE id = :id`, {
    id: contactId
  });
  if (data.isPrimary && existing?.bank_id) {
    await pool.execute(
      `UPDATE lender_contacts SET is_primary = FALSE, updated_at = NOW() WHERE bank_id = :bank_id`,
      { bank_id: existing.bank_id }
    );
  }
  await pool.execute(
    `UPDATE lender_contacts SET
       branch_id = COALESCE(:branch_id, branch_id),
       contact_name = COALESCE(:contact_name, contact_name),
       role_title = COALESCE(:role_title, role_title),
       department = COALESCE(:department, department),
       email = COALESCE(:email, email),
       phone = COALESCE(:phone, phone),
       is_primary = COALESCE(:is_primary, is_primary),
       notes = COALESCE(:notes, notes),
       updated_at = NOW()
     WHERE id = :id`,
    {
      id: contactId,
      branch_id: data.branchId ?? null,
      contact_name: data.contactName ?? null,
      role_title: data.roleTitle ?? null,
      department: data.department ?? null,
      email: data.email ?? null,
      phone: data.phone ?? null,
      is_primary: data.isPrimary ?? null,
      notes: data.notes ?? null
    }
  );
  const [[row]] = await pool.execute(`SELECT * FROM lender_contacts WHERE id = :id`, { id: contactId });
  return row;
}
async function deleteLenderContact(contactId) {
  await ensureLenderMasterSchema();
  const pool = getPool();
  await pool.execute(`UPDATE lender_contacts SET is_active = FALSE, updated_at = NOW() WHERE id = :id`, {
    id: contactId
  });
}
export {
  createLenderBranch,
  createLenderContact,
  deleteLenderBranch,
  deleteLenderContact,
  ensureLenderMasterSchema,
  listLenderBranches,
  listLenderContacts,
  updateLenderBranch,
  updateLenderContact
};
