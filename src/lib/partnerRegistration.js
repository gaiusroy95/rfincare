import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

import { getPool, isDuplicateEntryError, isDuplicateColumnError, isNoSuchTableError, isIgnorableMigrationError, isTableExistsError, isBadFieldError } from '../db/pool.js';
import { ensurePartnerRegistrationSchema } from '../db/ensurePartnerRegistrationSchema.js';
import { ensureOnboardingSchema } from '../db/ensureOnboardingSchema.js';
import { newId } from './ids.js';
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
    panCardUrl: docUrl(row.pan_card_path),
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

/**
 * Convert an existing customer account into an active agent account. Used when
 * a customer applies to become a partner with the same email they signed up with.
 * Returns the (existing) user id.
 */
async function upgradeCustomerToAgentAccount(pool, { userId, reg, username, password, agentCode, reviewerUserId }) {
  await ensureOnboardingSchema();
  const passwordHash = await bcrypt.hash(password, 12);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.execute(`UPDATE auth_users SET password_hash = :ph WHERE id = :id`, {
      ph: passwordHash,
      id: userId,
    });

    await conn.execute(
      `UPDATE user_profiles
       SET role = 'agent',
           full_name = COALESCE(NULLIF(:fullName, ''), full_name),
           phone = COALESCE(NULLIF(:phone, ''), phone),
           account_status = 'active',
           is_active = TRUE,
           onboarding_status = 'active'
       WHERE id = :id`,
      { id: userId, fullName: reg.full_name || '', phone: reg.phone || '' },
    );

    const [[existingOnb]] = await conn.execute(
      `SELECT id FROM agent_onboarding WHERE user_id = :id LIMIT 1`,
      { id: userId },
    );

    const onbParams = {
      user_id: userId,
      username,
      agent_name: reg.full_name,
      agent_code: agentCode,
      email: reg.email,
      mobile: reg.phone,
      acc: reg.account_number,
      bank: reg.bank_name,
      ifsc: String(reg.ifsc_code || '').toUpperCase(),
      by: reviewerUserId,
    };

    if (existingOnb) {
      await conn.execute(
        `UPDATE agent_onboarding
         SET username = :username, agent_name = :agent_name, agent_code = :agent_code,
             email = :email, mobile_number = :mobile, account_number = :acc,
             bank_name = :bank, ifsc_code = :ifsc, onboarding_status = 'active',
             qc_status = 'qc_approved', qc_at = NOW(), qc_approved_by = :by
         WHERE user_id = :user_id`,
        onbParams,
      );
    } else {
      await conn.execute(
        `INSERT INTO agent_onboarding (
           id, user_id, username, agent_name, agent_code, email, mobile_number,
           account_number, bank_name, ifsc_code, onboarding_status, qc_status,
           qc_at, qc_approved_by, created_by
         ) VALUES (
           :id, :user_id, :username, :agent_name, :agent_code, :email, :mobile,
           :acc, :bank, :ifsc, 'active', 'qc_approved', NOW(), :by, :by
         )`,
        { ...onbParams, id: newId() },
      );
    }

    await conn.commit();
    return userId;
  } catch (err) {
    await conn.rollback();
    if (isDuplicateEntryError(err)) {
      const e = new Error('Could not convert account: username or agent code already exists');
      e.status = 409;
      throw e;
    }
    throw err;
  } finally {
    conn.release();
  }
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
    `SELECT au.id, up.role
     FROM auth_users au
     LEFT JOIN user_profiles up ON up.id = au.id
     WHERE au.email = :email LIMIT 1`,
    { email: reg.email },
  );
  // Staff/agent accounts cannot be re-provisioned. A plain customer account is
  // upgraded in place to an agent so the partner can keep using the same email.
  if (existingUser && existingUser.role && existingUser.role !== 'customer') {
    const e = new Error('An account with this email already exists');
    e.status = 409;
    throw e;
  }

  const financialYear = getIndianFinancialYearLabel();
  const { code: agentCode } = await reserveUniqueAgentCodeForFy(pool, financialYear);
  const username = sanitizeUsername(reg.email.split('@')[0]);
  const password = generateTempPassword();

  let agentUserId;
  if (existingUser) {
    agentUserId = await upgradeCustomerToAgentAccount(pool, {
      userId: existingUser.id,
      reg,
      username,
      password,
      agentCode,
      reviewerUserId,
    });
  } else {
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
    agentUserId = agentRow.id;
  }

  await pool.execute(
    `UPDATE user_profiles
     SET account_status = 'active', is_active = TRUE, onboarding_status = 'active'
     WHERE id = :id`,
    { id: agentUserId },
  );
  await pool.execute(
    `UPDATE agent_onboarding
     SET onboarding_status = 'active', qc_status = 'qc_approved', qc_at = NOW(), qc_approved_by = :by
     WHERE user_id = :id`,
    { id: agentUserId, by: reviewerUserId },
  );

  await pool.execute(
    `UPDATE partner_registrations
     SET registration_status = 'approved',
         reviewed_by = :by,
         reviewed_at = NOW(),
         approved_at = NOW(),
         approved_user_id = :userId,
         assigned_agent_code = :code,
         financial_year = :fy
     WHERE id = :id`,
    {
      id: registrationId,
      by: reviewerUserId,
      userId: agentUserId,
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
    newValues: { agentCode, userId: agentUserId, email: reg.email },
  });

  return {
    registrationId,
    userId: agentUserId,
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
         reviewed_at = NOW()
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
