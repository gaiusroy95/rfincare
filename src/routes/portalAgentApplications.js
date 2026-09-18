import { Router } from 'express';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';
import { ensureStaffExtrasSchema } from '../db/ensureStaffExtrasSchema.js';
import { ensureStaffMessagingSchema } from '../db/ensureStaffMessagingSchema.js';
import { newId } from '../lib/ids.js';
import {
  provisionCustomerForAgent,
  calculateCommissionFromApplication,
  commissionStatusForApplication,
} from '../lib/agentCustomerProvision.js';
import { writeAuditLog } from '../lib/audit.js';
import { finalizeApplicationSubmission } from '../lib/applicationSubmissionService.js';
import { ensureAgentCodeForUser } from '../lib/agentCode.js';

export const portalAgentApplicationsRouter = Router();

function requireStaffAssist(req) {
  if (!['agent', 'employee', 'admin', 'super_admin'].includes(req.auth.role)) {
    const e = new Error('Staff access only');
    e.status = 403;
    throw e;
  }
}

function requireAgent(req) {
  if (req.auth.role !== 'agent' && !['admin', 'super_admin'].includes(req.auth.role)) {
    const e = new Error('Agent access only');
    e.status = 403;
    throw e;
  }
}

async function assertStaffOwnsApplication(pool, userId, role, applicationId) {
  const [[byEmployee]] = await pool.execute(
    `SELECT * FROM loan_applications
     WHERE id = :id AND CAST(COALESCE(assigned_employee_id, '') AS TEXT) = CAST(:userId AS TEXT)
     LIMIT 1`,
    { id: applicationId, userId },
  );
  if (byEmployee) return byEmployee;

  if (role === 'admin' || role === 'super_admin') {
    const [[any]] = await pool.execute(
      `SELECT * FROM loan_applications WHERE id = :id LIMIT 1`,
      { id: applicationId },
    );
    if (any) return any;
  }

  if (role === 'employee') {
    const e = new Error('Application not found or not assigned to you');
    e.status = 404;
    throw e;
  }

  return assertAgentOwnsApplication(pool, userId, applicationId);
}

async function resolveAgentMeta(pool, userId, { requireCode = false } = {}) {
  const [[row]] = await pool.execute(
    `SELECT up.full_name, up.email, ao.agent_code, ao.username
     FROM user_profiles up
     LEFT JOIN agent_onboarding ao ON ao.user_id = up.id
     WHERE up.id = :id LIMIT 1`,
    { id: userId },
  );
  const agentCode =
    (await ensureAgentCodeForUser(pool, userId)) ||
    row?.agent_code ||
    null;
  if (requireCode && !agentCode) {
    const e = new Error(
      'Your agent code is not set up yet. Contact admin to complete agent onboarding, then try again.',
    );
    e.status = 400;
    throw e;
  }
  return {
    agentId: userId,
    agentCode,
    agentName: row?.full_name || 'Agent',
    email: row?.email,
    username: row?.username,
  };
}

async function assertAgentOwnsApplication(pool, agentId, applicationId) {
  const meta = await resolveAgentMeta(pool, agentId, { requireCode: false });
  const params = { id: applicationId, agentId };
  const match = [
    `CAST(COALESCE(agent_id, '') AS TEXT) = CAST(:agentId AS TEXT)`,
  ];
  if (meta.agentCode) {
    params.code = meta.agentCode;
    match.push(
      `LOWER(TRIM(CAST(COALESCE(sourced_agent_code, '') AS TEXT))) = LOWER(TRIM(CAST(:code AS TEXT)))`,
    );
  }
  const [[row]] = await pool.execute(
    `SELECT * FROM loan_applications
     WHERE id = :id AND (${match.join(' OR ')})
     LIMIT 1`,
    params,
  );
  if (!row) {
    const e = new Error('Application not found or not linked to your agent code');
    e.status = 404;
    throw e;
  }
  return row;
}

function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

portalAgentApplicationsRouter.use(authenticate);

/** Agent eligibility — also mounted here so it cannot be shadowed by this router's catch-all auth. */
portalAgentApplicationsRouter.post('/eligibility/calculate', async (req, res, next) => {
  try {
    requireAgent(req);
    const { calculateEligibility } = await import('../lib/eligibilityEngine.js');
    const { z } = await import('zod');
    const schema = z.object({
      loanType: z.string().min(1),
      loanAmount: z.coerce.number().positive().max(1e12),
      monthlyIncome: z.coerce.number().positive().max(1e12),
      extraIncome: z.coerce.number().min(0).max(1e12).optional().default(0),
      employmentType: z.string().min(1),
      creditScore: z.string().optional(),
      creditScoreRange: z.string().optional(),
      existingLoans: z.coerce.number().min(0).max(1e12).optional().default(0),
      collateralValue: z.coerce.number().min(0).max(1e12).optional(),
      propertyValue: z.coerce.number().min(0).max(1e12).optional(),
      loanPurpose: z.string().optional(),
      dateOfBirth: z.string().optional(),
      age: z.coerce.number().optional(),
      yearsEmployed: z.coerce.number().min(0).max(60).optional(),
      pincode: z.string().optional(),
      pinCode: z.string().optional(),
      pin_code: z.string().optional(),
      currentPincode: z.string().optional(),
      permanentPincode: z.string().optional(),
      propertyPincode: z.string().optional(),
      district: z.string().optional(),
      fetchLiveCibil: z.boolean().optional(),
      refreshLiveCibil: z.boolean().optional(),
      consentAccepted: z.boolean().optional(),
      panNumber: z.string().optional(),
    }).refine((data) => data.creditScore || data.creditScoreRange || data.fetchLiveCibil, {
      message: 'Credit score range is required unless fetching live CIBIL',
      path: ['creditScore'],
    });
    const input = schema.parse(req.body || {});
    res.json(await calculateEligibility(input));
  } catch (err) {
    next(err);
  }
});

portalAgentApplicationsRouter.get('/profile', async (req, res, next) => {
  try {
    requireAgent(req);
    const pool = getPool();
    const meta = await resolveAgentMeta(pool, req.auth.userId);
    res.json(meta);
  } catch (err) {
    next(err);
  }
});

const ProvisionSchema = z.object({
  email: z.string().email(),
  phone: z.string().optional(),
  fullName: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  password: z.string().min(8).optional(),
});

portalAgentApplicationsRouter.post('/provision-customer', async (req, res, next) => {
  try {
    requireStaffAssist(req);
    const input = ProvisionSchema.parse(req.body);
    const pool = getPool();
    const result = await provisionCustomerForAgent(pool, input);

    await writeAuditLog({
      userId: req.auth.userId,
      actionType: 'staff_provision_customer',
      tableName: 'user_profiles',
      recordId: result.customerId,
      newValues: { email: input.email, created: result.created, byRole: req.auth.role },
    });

    res.status(result.created ? 201 : 200).json({
      customerId: result.customerId,
      created: result.created,
      temporaryPassword: result.temporaryPassword || null,
    });
  } catch (err) {
    next(err);
  }
});

portalAgentApplicationsRouter.post('/applications', async (req, res, next) => {
  try {
    requireStaffAssist(req);
    const pool = getPool();
    await ensureStaffMessagingSchema();
    const staffId = req.auth.userId;
    const role = req.auth.role;
    const body = req.body || {};
    const isEmployee =
      role === 'employee'
      || body.submission_channel === 'employee_assisted'
      || body.assisted_by_employee === true
      || body.assistedByEmployee === true;
    const customerId = body.customer_id || body.customerId;
    if (!customerId) {
      return res.status(400).json({ error: 'customerId is required' });
    }

    let agentId = null;
    let agentCode = null;
    let agentName = null;
    let assignedEmployeeId = body.assigned_employee_id || body.assignedEmployeeId || null;

    if (isEmployee) {
      assignedEmployeeId = assignedEmployeeId || staffId;
    } else {
      const meta = await resolveAgentMeta(pool, staffId, { requireCode: true });
      agentId = staffId;
      agentCode = meta.agentCode;
      agentName = meta.agentName;
      if (!assignedEmployeeId) {
        const [[primaryMap]] = await pool.execute(
          `SELECT employee_user_id FROM agent_employee_hierarchy
           WHERE agent_user_id = :agentId AND is_primary = 1
           ORDER BY hierarchy_level ASC LIMIT 1`,
          { agentId: staffId },
        );
        assignedEmployeeId = primaryMap?.employee_user_id || null;
      }
    }

    const leadId = body.lead_id || body.leadId || null;
    const id = newId();
    const payload = {
      ...body,
      customer_id: customerId,
      agent_id: agentId,
      assigned_employee_id: assignedEmployeeId,
      sourced_agent_code: agentCode,
      sourced_by_agent_name: agentName,
      submission_channel: isEmployee ? 'employee_assisted' : 'agent_assisted',
      lead_id: leadId,
      eligibility_check_id: body.eligibility_check_id || body.eligibilityCheckId || null,
    };

    await pool.execute(
      `INSERT INTO loan_applications (
        id, application_number, customer_id, agent_id, sourced_agent_code, assigned_employee_id,
        selected_bank_id, status, document_stage_status, bank_approval_status, eligibility_status, data
      ) VALUES (
        :id, :application_number, :customer_id, :agent_id, :sourced_agent_code, :assigned_employee_id,
        :selected_bank_id, :status, :document_stage_status, :bank_approval_status, :eligibility_status, :data
      )`,
      {
        id,
        application_number: body.application_number || `RFC${Date.now()}`,
        customer_id: customerId,
        agent_id: agentId,
        sourced_agent_code: agentCode,
        assigned_employee_id: assignedEmployeeId,
        selected_bank_id: body.selected_bank_id || body.selectedBankId || null,
        status: body.status || 'draft',
        document_stage_status: 'documents_pending',
        bank_approval_status: 'submitted_to_bank',
        eligibility_status: body.eligibility_status || body.eligibilityStatus || null,
        data: JSON.stringify(payload),
      },
    );

    if (leadId) {
      try {
        await pool.execute(
          `UPDATE marketing_leads SET
             application_id = :app_id,
             status = 'application_in_progress',
             updated_at = NOW()
           WHERE id = :lead_id`,
          { app_id: id, lead_id: leadId },
        );
      } catch {
        /* best-effort journey link */
      }
    }

    const [[row]] = await pool.execute(
      `SELECT la.*, c.full_name AS customer_full_name
       FROM loan_applications la
       LEFT JOIN user_profiles c ON c.id = la.customer_id
       WHERE la.id = :id LIMIT 1`,
      { id },
    );

    if (agentCode) {
      try {
        const { attachAttributionToApplication, attachAttributionToUser } = await import('../lib/referralEngine.js');
        await attachAttributionToUser(pool, customerId, {
          referralCode: agentCode,
          referralProgram: 'customer',
          sourcedAgentCode: agentCode,
        });
        await attachAttributionToApplication(pool, id, {
          referralCode: agentCode,
          sourcedAgentCode: agentCode,
          customerId,
        });
      } catch {
        /* best-effort */
      }
    }

    res.status(201).json({
      id: row.id,
      applicationNumber: row.application_number,
      customerId: row.customer_id,
      agentId: row.agent_id,
      assignedEmployeeId: row.assigned_employee_id,
      sourcedAgentCode: row.sourced_agent_code,
      status: row.status,
      customerName: row.customer_full_name,
      leadId: leadId || null,
    });
  } catch (err) {
    next(err);
  }
});

portalAgentApplicationsRouter.patch('/applications/:id', async (req, res, next) => {
  try {
    requireStaffAssist(req);
    const pool = getPool();
    const existing = await assertStaffOwnsApplication(
      pool,
      req.auth.userId,
      req.auth.role,
      req.params.id,
    );
    const body = req.body || {};
    const mergedData = { ...parseJson(existing.data), ...body };
    const {
      status,
      selected_bank_id: selectedBankId,
      selectedBankId: selectedBankIdCamel,
      ...rest
    } = body;

    await pool.execute(
      `UPDATE loan_applications SET
        status = COALESCE(:status, status),
        selected_bank_id = COALESCE(:selected_bank_id, selected_bank_id),
        data = :data,
        updated_at = NOW()
       WHERE id = :id`,
      {
        id: req.params.id,
        status: status || null,
        selected_bank_id: selectedBankId || selectedBankIdCamel || null,
        data: JSON.stringify({ ...mergedData, ...rest }),
      },
    );

    try {
      const statusLower = String(status || '').toLowerCase();
      if (statusLower === 'disbursed' || statusLower === 'approved') {
        const { evaluateReferralPayout } = await import('../lib/referralEngine.js');
        await evaluateReferralPayout(pool, req.params.id);
      } else if (statusLower === 'submitted') {
        const { attachAttributionToApplication, advanceAttributionLifecycle } =
          await import('../lib/referralEngine.js');
        const attr = await attachAttributionToApplication(pool, req.params.id, {});
        if (attr?.id) await advanceAttributionLifecycle(pool, attr.id, 'submitted');
      }
    } catch {
      /* best-effort */
    }

    res.json({ ok: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
});

portalAgentApplicationsRouter.post('/applications/:id/submit', async (req, res, next) => {
  try {
    requireStaffAssist(req);
    const pool = getPool();
    const staffId = req.auth.userId;
    const existing = await assertStaffOwnsApplication(pool, staffId, req.auth.role, req.params.id);

    await pool.execute(
      `UPDATE loan_applications
       SET status = 'submitted',
           document_stage_status = COALESCE(document_stage_status, 'documents_pending'),
           bank_approval_status = 'submitted_to_bank',
           submitted_at = NOW()
       WHERE id = :id`,
      { id: req.params.id },
    );

    await pool.execute(
      `INSERT INTO application_timeline (id, application_id, status, message)
       VALUES (:id, :application_id, 'submitted', :message)`,
      {
        id: newId(),
        application_id: req.params.id,
        message:
          req.auth.role === 'employee'
            ? 'Application submitted by employee on behalf of customer'
            : 'Application submitted by agent on behalf of customer',
      },
    );

    const clientIp =
      req.headers['x-forwarded-for']?.toString()?.split(',')?.[0]?.trim()
      || req.socket?.remoteAddress
      || null;

    const confirmation = await finalizeApplicationSubmission({
      applicationId: req.params.id,
      submittedByUserId: staffId,
      submittedByRole: req.auth.role === 'employee' ? 'employee' : 'agent',
      clientIp,
    });

    const leadId =
      parseJson(existing.data)?.lead_id
      || parseJson(existing.data)?.leadId
      || null;
    if (leadId) {
      try {
        await pool.execute(
          `UPDATE marketing_leads SET
             application_id = COALESCE(application_id, :app_id),
             status = 'application_submitted',
             updated_at = NOW()
           WHERE id = :lead_id`,
          { app_id: req.params.id, lead_id: leadId },
        );
      } catch {
        /* best-effort */
      }
    }

    try {
      const { attachAttributionToApplication, advanceAttributionLifecycle } =
        await import('../lib/referralEngine.js');
      const attr = await attachAttributionToApplication(pool, req.params.id, {});
      if (attr?.id) await advanceAttributionLifecycle(pool, attr.id, 'submitted');
    } catch {
      /* best-effort */
    }

    res.json({ ok: true, id: req.params.id, status: 'submitted', confirmation });
  } catch (err) {
    next(err);
  }
});
