import crypto from 'node:crypto';

import { getPool } from '../db/pool.js';
import { ensurePartnerRegistrationSchema } from '../db/ensurePartnerRegistrationSchema.js';
import { createAgentAccount } from './staffOnboarding.js';
import {
  getIndianFinancialYearLabel,
  reserveUniqueAgentCodeForFy,
} from './agentCode.js';
import {
  sendPartnerApplicationAdminEmail,
  sendPartnerRejectionEmail,
  sendPartnerWelcomeEmail,
} from './email.js';
import { getAdminVerifierEmails } from './adminVerificationEmails.js';
import { writeAuditLog } from './audit.js';

function sanitizeUsername(value) {
  const base = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, 24);
  return base.length >= 3 ? base : `agent${crypto.randomBytes(3).toString('hex')}`;
}

function generateTempPassword() {
  return `Rf@${crypto.randomBytes(4).toString('hex')}1`;
}

export async function getSuperAdminRecipientEmails(pool) {
  const [rows] = await pool.execute(
    `SELECT email FROM user_profiles
     WHERE role = 'super_admin' AND email IS NOT NULL AND LENGTH(TRIM(email)) > 0`,
  );
  const fromDb = rows.map((r) => String(r.email).trim().toLowerCase()).filter(Boolean);
  if (fromDb.length) return [...new Set(fromDb)];

  const verifiers = await getAdminVerifierEmails();
  if (verifiers.length) return verifiers;

  const fallback = process.env.SUPER_ADMIN_EMAIL || process.env.ADMIN_VERIFIER_EMAIL_1;
  return fallback ? [String(fallback).trim().toLowerCase()] : [];
}

export function mapPartnerRegistrationRow(row) {
  if (!row) return null;
  const base = process.env.API_PUBLIC_URL || process.env.APP_PUBLIC_URL || '';
  const uploadBase = base ? `${base.replace(/\/$/, '')}/uploads` : '/uploads';
  const docUrl = (path) => {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return path;
    const normalized = String(path).replace(/\\/g, '/').replace(/^\/+/, '');
    return `${uploadBase}/${normalized.split('/').map(encodeURIComponent).join('/')}`;
  };

  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    pinCode: row.pin_code,
    panNumber: row.pan_number,
    bankName: row.bank_name,
    accountNumber: row.account_number,
    branchAddress: row.branch_address,
    ifscCode: row.ifsc_code,
    photoUrl: docUrl(row.photo_path),
    cancelledChequeUrl: docUrl(row.cancelled_cheque_path),
    addressProofUrl: docUrl(row.address_proof_path),
    registrationStatus: row.registration_status,
    rejectionReason: row.rejection_reason,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    approvedAt: row.approved_at,
    approvedUserId: row.approved_user_id,
    assignedAgentCode: row.assigned_agent_code,
    financialYear: row.financial_year,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function notifyAdminsOfPartnerApplication(registration) {
  const pool = getPool();
  const recipients = await getSuperAdminRecipientEmails(pool);
  return sendPartnerApplicationAdminEmail({
    recipients,
    applicant: {
      fullName: registration.full_name,
      email: registration.email,
      phone: registration.phone,
      panNumber: registration.pan_number,
      bankName: registration.bank_name,
      ifscCode: registration.ifsc_code,
    },
  });
}

export async function approvePartnerRegistration(registrationId, reviewerUserId) {
  await ensurePartnerRegistrationSchema();
  const pool = getPool();

  const [[reg]] = await pool.execute(
    `SELECT * FROM partner_registrations WHERE id = :id LIMIT 1`,
    { id: registrationId },
  );
  if (!reg) {
    const e = new Error('Partner registration not found');
    e.status = 404;
    throw e;
  }
  if (reg.registration_status !== 'pending') {
    const e = new Error('Registration is not pending');
    e.status = 400;
    throw e;
  }

  const [[existingUser]] = await pool.execute(
    `SELECT id FROM auth_users WHERE email = :email LIMIT 1`,
    { email: reg.email },
  );
  if (existingUser) {
    const e = new Error('An account with this email already exists');
    e.status = 409;
    throw e;
  }

  const financialYear = getIndianFinancialYearLabel();
  const { code: agentCode } = await reserveUniqueAgentCodeForFy(pool, financialYear);
  const username = sanitizeUsername(reg.email.split('@')[0]);
  const password = generateTempPassword();

  const agentRow = await createAgentAccount(
    {
      username,
      password,
      email: reg.email,
      mobileNumber: reg.phone,
      agentName: reg.full_name,
      agentCode,
      accountNumber: reg.account_number,
      bankName: reg.bank_name,
      ifscCode: reg.ifsc_code,
    },
    reviewerUserId,
    { skipWelcomeEmail: true },
  );

  await pool.execute(
    `UPDATE user_profiles
     SET account_status = 'active', is_active = 1, onboarding_status = 'active'
     WHERE id = :id`,
    { id: agentRow.id },
  );
  await pool.execute(
    `UPDATE agent_onboarding
     SET onboarding_status = 'active', qc_status = 'qc_approved', qc_at = NOW(3), qc_approved_by = :by
     WHERE user_id = :id`,
    { id: agentRow.id, by: reviewerUserId },
  );

  await pool.execute(
    `UPDATE partner_registrations
     SET registration_status = 'approved',
         reviewed_by = :by,
         reviewed_at = NOW(3),
         approved_at = NOW(3),
         approved_user_id = :userId,
         assigned_agent_code = :code,
         financial_year = :fy
     WHERE id = :id`,
    {
      id: registrationId,
      by: reviewerUserId,
      userId: agentRow.id,
      code: agentCode,
      fy: financialYear,
    },
  );

  await sendPartnerWelcomeEmail({
    email: reg.email,
    fullName: reg.full_name,
    username,
    password,
    agentCode,
    financialYear,
  }).catch((err) => console.warn('[partner-welcome-email]', err?.message));

  await writeAuditLog({
    userId: reviewerUserId,
    actionType: 'APPROVE',
    tableName: 'partner_registrations',
    recordId: registrationId,
    newValues: { agentCode, userId: agentRow.id, email: reg.email },
  });

  return {
    registrationId,
    userId: agentRow.id,
    agentCode,
    financialYear,
    username,
  };
}

export async function rejectPartnerRegistration(registrationId, reviewerUserId, reason) {
  await ensurePartnerRegistrationSchema();
  const pool = getPool();

  const [[reg]] = await pool.execute(
    `SELECT * FROM partner_registrations WHERE id = :id LIMIT 1`,
    { id: registrationId },
  );
  if (!reg) {
    const e = new Error('Partner registration not found');
    e.status = 404;
    throw e;
  }
  if (reg.registration_status !== 'pending') {
    const e = new Error('Registration is not pending');
    e.status = 400;
    throw e;
  }

  await pool.execute(
    `UPDATE partner_registrations
     SET registration_status = 'rejected',
         rejection_reason = :reason,
         reviewed_by = :by,
         reviewed_at = NOW(3)
     WHERE id = :id`,
    { id: registrationId, reason: reason || null, by: reviewerUserId },
  );

  await sendPartnerRejectionEmail({
    email: reg.email,
    fullName: reg.full_name,
    reason,
  }).catch((err) => console.warn('[partner-reject-email]', err?.message));

  await writeAuditLog({
    userId: reviewerUserId,
    actionType: 'REJECT',
    tableName: 'partner_registrations',
    recordId: registrationId,
    newValues: { reason },
  });

  return { success: true };
}
