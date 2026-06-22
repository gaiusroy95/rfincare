import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';

import { authenticate } from '../middleware/authenticate.js';
import { getPool } from '../db/pool.js';
import { ensureMilestone4Schema } from '../db/ensureMilestone4Schema.js';
import { ensureStaffOnboardingCollation } from '../db/ensureOnboardingSchema.js';
import { dispatchFileUpdateNotification } from '../lib/fileNotificationService.js';
import { ensureAgentCodeForUser } from '../lib/agentCode.js';
import { sendStaffWelcomeEmail } from '../lib/email.js';
import { sqlCastParam } from '../lib/sqlCollation.js';
import {
  assertEmployeeAccess,
  getEffectiveEmployeeAccess,
  requireEmployeeModuleAccess,
} from '../lib/employeeAccessControls.js';

export const portalEmployeeMilestone4Router = Router();

function requireEmployee(req) {
  if (!['employee', 'admin', 'super_admin'].includes(req.auth.role)) {
    const e = new Error('Employee access only');
    e.status = 403;
    throw e;
  }
}

portalEmployeeMilestone4Router.use(authenticate);

portalEmployeeMilestone4Router.get('/customers/:customerId', async (req, res, next) => {
  try {
    requireEmployee(req);
    await assertEmployeeAccess(req, 'customers', 'read');
    const pool = getPool();
    const [[customer]] = await pool.execute(
      `SELECT id, full_name, email, phone, avatar_url, customer_code, created_at
       FROM user_profiles WHERE id = :id AND role = 'customer' LIMIT 1`,
      { id: req.params.customerId },
    );
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const [applications] = await pool.execute(
      `SELECT id, application_number, status, journey_mode, submitted_at, created_at
       FROM loan_applications WHERE customer_id = :id ORDER BY created_at DESC`,
      { id: req.params.customerId },
    );

    res.json({
      customer: {
        id: customer.id,
        fullName: customer.full_name,
        email: customer.email,
        phone: customer.phone,
        customerCode: customer.customer_code,
        createdAt: customer.created_at,
      },
      applications,
    });
  } catch (err) {
    next(err);
  }
});

portalEmployeeMilestone4Router.get('/agent-onboarding/pending', async (req, res, next) => {
  try {
    requireEmployee(req);
    if (req.auth.role === 'employee') {
      const access = await getEffectiveEmployeeAccess(req.auth.userId);
      requireEmployeeModuleAccess(access, 'agents', 'read');
    }
    await ensureMilestone4Schema();
    await ensureStaffOnboardingCollation();
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT ao.*, up.full_name, up.email, up.phone
       FROM agent_onboarding ao
       JOIN user_profiles up ON up.id = ao.user_id
       WHERE CONVERT(ao.qc_status USING utf8mb4) COLLATE utf8mb4_general_ci
         IN ('pending_qc', 'qc_review')
       ORDER BY ao.created_at ASC`,
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        agentName: r.agent_name,
        agentCode: r.agent_code,
        username: r.username,
        email: r.email,
        mobileNumber: r.mobile_number,
        bankName: r.bank_name,
        accountNumber: r.account_number,
        ifscCode: r.ifsc_code,
        qcStatus: r.qc_status,
        onboardingStatus: r.onboarding_status,
        createdAt: r.created_at,
      })),
    );
  } catch (err) {
    next(err);
  }
});

const QcDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  notes: z.string().optional(),
  temporaryPassword: z.string().min(8).optional(),
  password: z.string().min(8).optional(),
});

portalEmployeeMilestone4Router.post('/agent-onboarding/:userId/qc', async (req, res, next) => {
  try {
    requireEmployee(req);
    await ensureMilestone4Schema();
    await ensureStaffOnboardingCollation();
    const input = QcDecisionSchema.parse(req.body);
    const tempPassword = input.temporaryPassword || input.password || null;
    if (req.auth.role === 'employee') {
      const access = await getEffectiveEmployeeAccess(req.auth.userId);
      requireEmployeeModuleAccess(
        access,
        'agents',
        input.decision === 'approved' ? 'approve' : 'reject',
      );
    }
    const pool = getPool();

    const [[agent]] = await pool.execute(
      `SELECT * FROM agent_onboarding WHERE user_id = :id LIMIT 1`,
      { id: req.params.userId },
    );
    if (!agent) return res.status(404).json({ error: 'Agent onboarding not found' });

    if (input.decision === 'approved') {
      if (tempPassword) {
        const passwordHash = await bcrypt.hash(tempPassword, 12);
        await pool.execute(`UPDATE auth_users SET password_hash = :ph WHERE id = :id`, {
          ph: passwordHash,
          id: req.params.userId,
        });
        await pool.execute(
          `UPDATE user_profiles SET password_change_required = 0 WHERE id = :id`,
          { id: req.params.userId },
        );
      }

      await ensureAgentCodeForUser(pool, req.params.userId);
      await pool.execute(
        `UPDATE agent_onboarding
         SET qc_status = ${sqlCastParam('qc_status')},
             qc_employee_id = :emp,
             qc_notes = IF(:notes IS NULL, qc_notes, ${sqlCastParam('notes')}),
             qc_at = NOW(3),
             qc_approved_by = :emp,
             onboarding_status = ${sqlCastParam('onboarding_status')}
         WHERE user_id = :id`,
        {
          id: req.params.userId,
          emp: req.auth.userId,
          notes: input.notes || null,
          qc_status: 'qc_approved',
          onboarding_status: 'active',
        },
      );
      await pool.execute(
        `UPDATE user_profiles SET
           is_active = 1,
           account_status = ${sqlCastParam('account_status')},
           onboarding_status = ${sqlCastParam('profile_onboarding_status')}
         WHERE id = :id`,
        {
          id: req.params.userId,
          account_status: 'active',
          profile_onboarding_status: 'active',
        },
      );

      if (tempPassword) {
        await sendStaffWelcomeEmail({
          email: agent.email,
          fullName: agent.agent_name,
          role: 'agent',
          password: tempPassword,
          loginPath: '/agent-login',
        }).catch((err) => console.warn('[agent-qc-email]', err.message));
      }
    } else {
      await pool.execute(
        `UPDATE agent_onboarding
         SET qc_status = ${sqlCastParam('qc_status')},
             qc_employee_id = :emp,
             qc_notes = ${sqlCastParam('notes')},
             qc_at = NOW(3),
             onboarding_status = ${sqlCastParam('onboarding_status')}
         WHERE user_id = :id`,
        {
          id: req.params.userId,
          emp: req.auth.userId,
          notes: input.notes || 'QC rejected',
          qc_status: 'qc_rejected',
          onboarding_status: 'rejected',
        },
      );
      await pool.execute(
        `UPDATE user_profiles SET
           is_active = 0,
           account_status = ${sqlCastParam('account_status')},
           onboarding_status = ${sqlCastParam('profile_onboarding_status')}
         WHERE id = :id`,
        {
          id: req.params.userId,
          account_status: 'suspended',
          profile_onboarding_status: 'rejected',
        },
      );
    }

    res.json({ success: true, decision: input.decision });
  } catch (err) {
    next(err);
  }
});

portalEmployeeMilestone4Router.get('/notifications', async (req, res, next) => {
  try {
    requireEmployee(req);
    await ensureMilestone4Schema();
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT id, application_id, event_type, title, message, is_read, created_at
       FROM staff_notifications WHERE user_id = :uid ORDER BY created_at DESC LIMIT 50`,
      { uid: req.auth.userId },
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});
