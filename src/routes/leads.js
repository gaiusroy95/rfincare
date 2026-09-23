import { Router } from 'express';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { ensureOnboardingSchema } from '../db/ensureOnboardingSchema.js';
import { newId } from '../lib/ids.js';
import { hashOtp, sendDualChannelOtp, sendOtpNotification, toPublicOtpMessage } from '../lib/otp.js';
import { getOtpProviderSettings } from '../lib/otpProviderSettings.js';
import {
  createResumeToken,
  ensureLeadDraftSession,
  upsertLeadFromDraft,
} from '../lib/resumeTokens.js';
import {
  findMarketingLeadByContact,
  normalizeLeadPhone,
  upsertMarketingLead,
} from '../lib/marketingLeads.js';
import { normalizeAgentCode } from '../lib/agentAttribution.js';
import { ensureAgentCodeForUser } from '../lib/agentCode.js';
import { applyReferralToLead, ensureReferralSchema } from '../lib/referralTracking.js';
import {
  ensureLeadAssignmentSchema,
  ensureLeadTatClock,
  enrichLeadTatFields,
  getLeadAssignmentSettings,
  getLeadPerformanceReport,
  listLeadActivities,
  listRedZoneLeads,
  processTatMissReassignments,
  recordLeadActivity,
  recordLeadContact,
  refreshOverdueTatStatuses,
  resolveEmployeeLeadScope,
  updateLeadAssignmentSettings,
} from '../lib/leadAssignmentEngine.js';
import { authenticate } from '../middleware/authenticate.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { hasPermission } from '../auth/permissions.js';
import { sqlCastParam, sqlParamEquals, sqlLiteralEquals } from '../lib/sqlCollation.js';

export const leadsRouter = Router();

function canReadLeads(role) {
  return (
    hasPermission(role, 'read:*')
    || hasPermission(role, 'manage:*')
    || role === 'admin'
    || role === 'super_admin'
    || role === 'employee'
  );
}

function canManageLeads(role) {
  return hasPermission(role, 'manage:*') || role === 'admin' || role === 'super_admin';
}

function formatProductType(value) {
  if (!value) return '';
  return String(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function csvEscape(value) {
  if (value == null) return '';
  const normalized = String(value).replace(/\r?\n/g, ' ').trim();
  if (normalized.includes('"') || normalized.includes(',') || normalized.includes(';')) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

function formatLead(row, settings = null) {
  if (!row) return null;
  const tat = enrichLeadTatFields(row, settings);
  return {
    id: row.id,
    fullName: row.full_name,
    full_name: row.full_name,
    email: row.email,
    phone: row.phone,
    loanType: row.loan_type,
    loan_type: row.loan_type,
    loanAmount: tat.loanAmount,
    employmentType: tat.employmentType,
    locationCity: tat.locationCity,
    source: row.source,
    status: row.status,
    consentAccepted: !!row.consent_accepted,
    consentVerifiedAt: row.consent_verified_at,
    eligibilityScore: row.eligibility_score,
    eligibilityData:
      typeof row.eligibility_data === 'object'
        ? row.eligibility_data
        : row.eligibility_data
          ? JSON.parse(row.eligibility_data)
          : null,
    assignedTo: row.assigned_to,
    assignedToName: row.assignee_name || null,
    assignedToCode: row.assignee_code || null,
    assignedToRole: row.assignee_role || null,
    previousAssignedTo: tat.previousAssignedTo,
    previousAssigneeName: row.previous_assignee_name || null,
    previousAssigneeCode: row.previous_assignee_code || null,
    sourcedAgentCode: row.sourced_agent_code || null,
    referralCode: row.referral_code || null,
    referralProgram: row.referral_program || null,
    referredByUserId: row.referred_by_user_id || null,
    applicationId: row.application_id,
    sessionKey: row.session_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    assignedAt: tat.assignedAt,
    firstContactAt: tat.firstContactAt,
    firstContactDueAt: tat.firstContactDueAt,
    firstContactChannel: tat.firstContactChannel,
    tatMinutes: tat.tatMinutes,
    tatStatus: tat.tatStatus,
    tatZone: tat.tatZone,
    tatRemainingSeconds: tat.tatRemainingSeconds,
    assignmentMethod: tat.assignmentMethod,
    redZone: tat.redZone,
    reassignmentCount: tat.reassignmentCount,
    contactAttemptedAt: tat.contactAttemptedAt,
    contactConnectedAt: tat.contactConnectedAt,
    callAttemptCount: tat.callAttemptCount,
    whatsappMessageCount: tat.whatsappMessageCount,
    nextFollowUpAt: tat.nextFollowUpAt,
    employeeRemarks: tat.employeeRemarks,
  };
}

const CreateLeadSchema = z.object({
  fullName: z.string().min(1).optional(),
  full_name: z.string().min(1).optional(),
  email: z.union([z.string().email(), z.literal('')]).optional(),
  phone: z.string().min(10),
  loanType: z.string().optional(),
  loan_type: z.string().optional(),
  source: z.string().optional(),
  consentAccepted: z.boolean().optional(),
  consent_accepted: z.boolean().optional(),
  consentToken: z.string().optional().nullable(),
  consent_token: z.string().optional().nullable(),
  otpId: z.string().optional().nullable(),
  otp_id: z.string().optional().nullable(),
  sessionKey: z.string().optional(),
  session_key: z.string().optional(),
  sourcedAgentCode: z.string().optional().nullable(),
  sourced_agent_code: z.string().optional().nullable(),
  agentCode: z.string().optional().nullable(),
  referralCode: z.string().optional().nullable(),
  referral_code: z.string().optional().nullable(),
  referralProgram: z.string().optional().nullable(),
  referral_program: z.string().optional().nullable(),
  leadKind: z.enum(['customer', 'agent']).optional().nullable(),
  lead_kind: z.enum(['customer', 'agent']).optional().nullable(),
  assignedTo: z.string().optional().nullable(),
  assigned_to: z.string().optional().nullable(),
  agentUserId: z.string().optional().nullable(),
  agent_user_id: z.string().optional().nullable(),
  eligibilityScore: z.coerce.number().optional().nullable(),
  eligibility_score: z.coerce.number().optional().nullable(),
  eligibilityData: z.record(z.unknown()).optional().nullable(),
  eligibility_data: z.record(z.unknown()).optional().nullable(),
  loanAmount: z.coerce.number().optional().nullable(),
  loan_amount: z.coerce.number().optional().nullable(),
  employmentType: z.string().optional().nullable(),
  employment_type: z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
  panNumber: z.string().optional().nullable(),
  pan_number: z.string().optional().nullable(),
});

async function applyAgentCodeToLead(pool, leadId, body) {
  await ensureReferralSchema(pool);
  const applied = await applyReferralToLead(pool, leadId, body);
  // Always stamp explicit agent code so agent-portal creates show in the pipeline,
  // even when a prior referral payload resolved without sourced_agent_code.
  const agentCode = normalizeAgentCode(
    body.sourcedAgentCode || body.sourced_agent_code || body.agentCode,
  );
  if (agentCode && leadId) {
    try {
      await pool.execute(
        `UPDATE marketing_leads SET sourced_agent_code = :code WHERE id = :id`,
        { code: agentCode, id: leadId },
      );
    } catch {
      /* column may not exist until migration */
    }
  }
  return applied;
}

/**
 * Soft-auth: stamp agent/employee attribution from Bearer token when present.
 * Returns { body, agentUserId, employeeUserId }.
 */
async function attachAuthenticatedStaffAttribution(req, pool, body) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
    if (!token) return { body, agentUserId: null, employeeUserId: null };
    const payload = verifyAccessToken(token);
    if (!payload?.sub) return { body, agentUserId: null, employeeUserId: null };
    const [[profile]] = await pool.execute(
      `SELECT id, role FROM user_profiles WHERE id = :id LIMIT 1`,
      { id: payload.sub },
    );
    if (!profile) return { body, agentUserId: null, employeeUserId: null };

    const role = String(profile.role || '').toLowerCase();
    if (role === 'agent') {
      const agentCode = normalizeAgentCode(await ensureAgentCodeForUser(pool, profile.id));
      return {
        body: {
          ...body,
          ...(agentCode ? { sourcedAgentCode: agentCode, agentCode } : {}),
          source: body.source || 'agent_portal',
        },
        agentUserId: profile.id,
        employeeUserId: null,
      };
    }

    if (role === 'employee') {
      return {
        body: {
          ...body,
          source: body.source || 'employee_portal',
        },
        agentUserId: null,
        employeeUserId: profile.id,
      };
    }

    return { body, agentUserId: null, employeeUserId: null };
  } catch {
    return { body, agentUserId: null, employeeUserId: null };
  }
}

/** @deprecated use attachAuthenticatedStaffAttribution */
async function attachAuthenticatedAgentCode(req, pool, body) {
  const result = await attachAuthenticatedStaffAttribution(req, pool, body);
  return result;
}

leadsRouter.post('/', async (req, res, next) => {
  try {
    let body = CreateLeadSchema.parse(req.body);
    const pool = getPool();
    const attached = await attachAuthenticatedStaffAttribution(req, pool, body);
    body = attached.body;
    const agentUserId = attached.agentUserId;
    const employeeUserId = attached.employeeUserId;
    const fullName = body.fullName || body.full_name || '';
    const sessionKey = body.sessionKey || body.session_key || null;
    const leadKind = String(body.leadKind || body.lead_kind || '').toLowerCase();
    const source =
      body.source
      || (agentUserId ? 'agent_portal' : null)
      || (employeeUserId && leadKind === 'agent' ? 'employee_agent_lead' : null)
      || (employeeUserId ? 'employee_portal' : null)
      || 'eligibility';

    // Staff capture (employee customer/agent leads + agent portal) requires call-consent OTP.
    let callConsentVerified = false;
    if (employeeUserId || agentUserId) {
      const { assertCallConsentToken } = await import('../lib/callConsentOtp.js');
      await assertCallConsentToken({
        phone: body.phone,
        consentToken: body.consentToken || body.consent_token,
        otpId: body.otpId || body.otp_id,
      });
      callConsentVerified = true;
    }

    const { row, created } = await upsertMarketingLead(pool, {
      fullName,
      email:
        String(body.email || '').trim()
        || (await import('../lib/marketingLeads.js')).eligibilityPlaceholderEmail(body.phone),
      phone: body.phone,
      loanType: body.loanType || body.loan_type || null,
      source,
      consentAccepted: Boolean(body.consentAccepted || body.consent_accepted || callConsentVerified),
      sessionKey,
      status: 'new',
      // Staff-captured leads are assigned below; skip queue so they don't bounce to another L1.
      skipAutoAssign: Boolean(agentUserId || employeeUserId || body.assignedTo || body.assigned_to),
    });

    if (callConsentVerified && row?.id) {
      await pool.execute(
        `UPDATE marketing_leads
         SET consent_accepted = TRUE, consent_verified_at = NOW(), updated_at = NOW()
         WHERE id = :id`,
        { id: row.id },
      ).catch(() => {});
    }

    await applyAgentCodeToLead(pool, row?.id, body);

    let assigneeId = body.assignedTo || body.assigned_to || null;
    let stampAgentCode = normalizeAgentCode(
      body.sourcedAgentCode || body.sourced_agent_code || body.agentCode,
    );

    // Agent portal create → assign to that agent.
    if (agentUserId && row?.id) {
      assigneeId = agentUserId;
    }

    // Employee creates:
    // - customer lead → assign to employee
    // - agent lead → assign to selected agent (+ stamp their code)
    if (employeeUserId && row?.id) {
      if (leadKind === 'agent') {
        const selectedAgentId = body.agentUserId || body.agent_user_id || assigneeId;
        if (selectedAgentId) {
          const [[agentRow]] = await pool.execute(
            `SELECT up.id, ao.agent_code
             FROM user_profiles up
             LEFT JOIN agent_onboarding ao ON ao.user_id = up.id
             WHERE up.id = :id AND up.role = 'agent'
             LIMIT 1`,
            { id: selectedAgentId },
          );
          if (agentRow) {
            assigneeId = agentRow.id;
            stampAgentCode =
              stampAgentCode
              || normalizeAgentCode(await ensureAgentCodeForUser(pool, agentRow.id))
              || normalizeAgentCode(agentRow.agent_code);
          }
        }
      } else {
        // Default customer lead captured by employee
        assigneeId = assigneeId || employeeUserId;
      }
    }

    if (row?.id && (assigneeId || stampAgentCode)) {
      try {
        await pool.execute(
          `UPDATE marketing_leads
           SET assigned_to = COALESCE(:assignee, assigned_to),
               status = CASE WHEN :assignee IS NOT NULL THEN 'assigned' ELSE status END,
               sourced_agent_code = COALESCE(:code, sourced_agent_code),
               source = COALESCE(NULLIF(TRIM(source), ''), :source),
               assignment_method = CASE
                 WHEN :assignee IS NOT NULL THEN COALESCE(assignment_method, 'manual')
                 ELSE assignment_method
               END,
               updated_at = NOW()
           WHERE id = :id`,
          {
            id: row.id,
            assignee: assigneeId || null,
            code: stampAgentCode || null,
            source,
          },
        );
        if (assigneeId) {
          await ensureLeadTatClock(pool, row.id).catch(() => {});
        }
      } catch {
        /* ignore */
      }
    }

    // Persist eligibility snapshot / customer KYC captured at check time.
    const eligibilityData = body.eligibilityData || body.eligibility_data || null;
    const eligibilityScore = body.eligibilityScore ?? body.eligibility_score ?? null;
    const loanAmount = body.loanAmount ?? body.loan_amount ?? null;
    const employmentType = body.employmentType || body.employment_type || null;
    if (row?.id && (eligibilityData || eligibilityScore != null || loanAmount != null || employmentType)) {
      try {
        await pool.execute(
          `UPDATE marketing_leads SET
             eligibility_score = COALESCE(:score, eligibility_score),
             eligibility_data = COALESCE(:data, eligibility_data),
             loan_amount = COALESCE(:loan_amount, loan_amount),
             employment_type = COALESCE(:employment_type, employment_type),
             loan_type = COALESCE(:loan_type, loan_type),
             updated_at = NOW()
           WHERE id = :id`,
          {
            id: row.id,
            score: eligibilityScore,
            data: eligibilityData ? JSON.stringify(eligibilityData) : null,
            loan_amount: loanAmount != null ? Number(loanAmount) : null,
            employment_type: employmentType || null,
            loan_type: body.loanType || body.loan_type || null,
          },
        );
      } catch {
        /* columns may be missing on older DBs */
      }
    }

    const [[fresh]] = await pool.execute(
      `SELECT ml.*,
              up.full_name AS assignee_name,
              up.role AS assignee_role,
              COALESCE(ao.agent_code, eo.employee_code) AS assignee_code
       FROM marketing_leads ml
       LEFT JOIN user_profiles up ON up.id = ml.assigned_to
       LEFT JOIN agent_onboarding ao ON ao.user_id = up.id AND up.role = 'agent'
       LEFT JOIN employee_onboarding eo ON eo.user_id = up.id AND up.role = 'employee'
       WHERE ml.id = :id`,
      { id: row?.id },
    );

    res.status(created ? 201 : 200).json({
      ...formatLead(fresh || row),
      created,
      updated: !created,
    });
  } catch (err) {
    next(err);
  }
});

leadsRouter.get('/otp-settings', async (_req, res, next) => {
  try {
    const settings = await getOtpProviderSettings();
    res.json({
      requireMobileOtp: settings.requireMobileOtp,
      requireEmailOtp: settings.requireEmailOtp,
      smsProvider: settings.smsProvider,
      emailProvider: settings.emailProvider,
    });
  } catch (err) {
    next(err);
  }
});

leadsRouter.get('/assignment-settings', authenticate, async (req, res, next) => {
  try {
    if (!canReadLeads(req.auth.role)) {
      const e = new Error('Insufficient permissions');
      e.status = 403;
      throw e;
    }
    const pool = getPool();
    const settings = await getLeadAssignmentSettings(pool);
    let leadScope = null;
    if (req.auth.role === 'employee') {
      leadScope = await resolveEmployeeLeadScope(pool, req.auth.userId);
    }
    res.json({ ...settings, leadScope });
  } catch (err) {
    next(err);
  }
});

leadsRouter.put('/assignment-settings', authenticate, async (req, res, next) => {
  try {
    if (!canManageLeads(req.auth.role)) {
      const e = new Error('Insufficient permissions');
      e.status = 403;
      throw e;
    }
    const pool = getPool();
    const settings = await updateLeadAssignmentSettings(pool, {
      firstContactTatMinutes: req.body?.firstContactTatMinutes ?? req.body?.first_contact_tat_minutes,
      roundRobinEnabled: req.body?.roundRobinEnabled ?? req.body?.round_robin_enabled,
      amberWarningMinutes: req.body?.amberWarningMinutes ?? req.body?.amber_warning_minutes,
      redZoneMinutes: req.body?.redZoneMinutes ?? req.body?.red_zone_minutes,
      autoReassignEnabled: req.body?.autoReassignEnabled ?? req.body?.auto_reassign_enabled,
      maxReassignments: req.body?.maxReassignments ?? req.body?.max_reassignments,
      notifyEmailEnabled: req.body?.notifyEmailEnabled ?? req.body?.notify_email_enabled,
      notifyWhatsappEnabled: req.body?.notifyWhatsappEnabled ?? req.body?.notify_whatsapp_enabled,
    });
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

leadsRouter.get('/red-zone', authenticate, async (req, res, next) => {
  try {
    if (!canReadLeads(req.auth.role)) {
      const e = new Error('Insufficient permissions');
      e.status = 403;
      throw e;
    }
    const pool = getPool();
    const settings = await getLeadAssignmentSettings(pool);
    await processTatMissReassignments(pool, { limit: 25 }).catch(() => null);
    const rows = await listRedZoneLeads(pool, { limit: Number(req.query.limit) || 100 });
    res.json(rows.map((r) => formatLead(r, settings)));
  } catch (err) {
    next(err);
  }
});

leadsRouter.get('/performance-report', authenticate, async (req, res, next) => {
  try {
    if (!canManageLeads(req.auth.role) && req.auth.role !== 'employee') {
      const e = new Error('Insufficient permissions');
      e.status = 403;
      throw e;
    }
    if (req.auth.role === 'employee') {
      const pool = getPool();
      const scope = await resolveEmployeeLeadScope(pool, req.auth.userId);
      if (scope.scope !== 'team') {
        const e = new Error('Insufficient permissions');
        e.status = 403;
        throw e;
      }
    }
    const pool = getPool();
    const report = await getLeadPerformanceReport(pool);
    res.json(report);
  } catch (err) {
    next(err);
  }
});

/** Cron / ops hook: process TAT misses and reassign. */
leadsRouter.post('/cron/tat-reassign', async (req, res, next) => {
  try {
    const secret = process.env.LEAD_TAT_CRON_SECRET || process.env.ENGAGEMENT_CRON_SECRET;
    const header = req.get('X-Lead-Tat-Cron-Secret') || req.get('X-Engagement-Cron-Secret') || req.query.secret;
    const isAuthedStaff = (() => {
      try {
        const auth = req.headers.authorization || '';
        if (!auth.startsWith('Bearer ')) return false;
        const payload = verifyAccessToken(auth.slice(7));
        return payload && canManageLeads(payload.role);
      } catch {
        return false;
      }
    })();
    if ((!secret || header !== secret) && !isAuthedStaff) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const pool = getPool();
    const result = await processTatMissReassignments(pool, {
      limit: Math.min(200, Math.max(1, parseInt(req.body?.limit || req.query.limit, 10) || 50)),
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

/** Agents list for employee lead capture (syncs attribution into Admin leads). */
leadsRouter.get('/agent-options', authenticate, async (req, res, next) => {
  try {
    const role = req.auth.role;
    if (
      !canReadLeads(role)
      && role !== 'agent'
    ) {
      const e = new Error('Insufficient permissions');
      e.status = 403;
      throw e;
    }
    await ensureOnboardingSchema();
    const pool = getPool();
    const [agents] = await pool.execute(
      `SELECT up.id, up.full_name, up.email, up.account_status,
              ao.agent_code, ao.username
       FROM user_profiles up
       LEFT JOIN agent_onboarding ao ON ao.user_id = up.id
       WHERE up.role = 'agent'
         AND COALESCE(up.is_active, TRUE) = TRUE
       ORDER BY up.full_name ASC, up.email ASC`,
    );
    res.json(
      (agents || []).map((row) => {
        const code = row.agent_code || '—';
        const name = row.full_name || row.email || 'Agent';
        return {
          id: row.id,
          name,
          code,
          email: row.email,
          label: `${code} — ${name}`,
        };
      }),
    );
  } catch (err) {
    next(err);
  }
});

async function persistLeadOtps(pool, { leadId, email, phone, settings, mobileOtp, emailOtp }) {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const otpIds = {};

  if (settings.requireMobileOtp !== false && mobileOtp) {
    const smsId = newId();
    await pool.execute(
      `INSERT INTO lead_otps (id, lead_id, email, phone, otp_hash, purpose, channel, expires_at)
       VALUES (
         :id, :lead_id, ${sqlCastParam('email')}, ${sqlCastParam('phone')}, ${sqlCastParam('hash')},
         ${sqlCastParam('purpose')}, ${sqlCastParam('channel')}, :exp
       )`,
      {
        id: smsId,
        lead_id: leadId,
        email,
        phone,
        hash: hashOtp(mobileOtp),
        purpose: 'lead_verify',
        channel: 'sms',
        exp: expiresAt,
      },
    );
    otpIds.sms = smsId;
  }

  if (settings.requireEmailOtp !== false && emailOtp) {
    const emailId = newId();
    await pool.execute(
      `INSERT INTO lead_otps (id, lead_id, email, phone, otp_hash, purpose, channel, expires_at)
       VALUES (
         :id, :lead_id, ${sqlCastParam('email')}, ${sqlCastParam('phone')}, ${sqlCastParam('hash')},
         ${sqlCastParam('purpose')}, ${sqlCastParam('channel')}, :exp
       )`,
      {
        id: emailId,
        lead_id: leadId,
        email,
        phone,
        hash: hashOtp(emailOtp),
        purpose: 'lead_verify',
        channel: 'email',
        exp: expiresAt,
      },
    );
    otpIds.email = emailId;
  }

  return otpIds;
}

function formatOtpSendResponse({
  settings,
  mobileOtp,
  emailOtp,
  otpIds,
  warnings = [],
  otpResult,
  publicFacing = true,
}) {
  const requireMobileOtp = otpResult?.requireMobileOtp ?? settings.requireMobileOtp;
  const requireEmailOtp = otpResult?.requireEmailOtp ?? settings.requireEmailOtp;

  return {
    success: true,
    otpIds,
    expiresInSeconds: 600,
    requireMobileOtp,
    requireEmailOtp,
    emailDelivered: otpResult?.emailDelivered,
    smsDelivered: otpResult?.smsDelivered,
    // Provider names / warnings are ops-only — never leak MSG91/SMTP internals to customers.
    ...(publicFacing
      ? {}
      : {
          smsProvider: settings.smsProvider,
          emailProvider: settings.emailProvider,
          warnings: warnings.length ? warnings : undefined,
        }),
    ...(process.env.LOG_OTP === 'true'
      ? { devMobileOtp: mobileOtp, devEmailOtp: emailOtp }
      : {}),
  };
}

function effectiveOtpSettings(settings, otpResult) {
  return {
    ...settings,
    requireMobileOtp: otpResult.requireMobileOtp !== false,
    requireEmailOtp: otpResult.requireEmailOtp !== false,
  };
}

/** Create/update lead and send OTP in one request (eligibility gate). */
leadsRouter.post('/start-verification', async (req, res, next) => {
  try {
    let body = CreateLeadSchema.parse(req.body);
    const pool = getPool();
    const attached = await attachAuthenticatedAgentCode(req, pool, body);
    body = attached.body;
    const fullName = body.fullName || body.full_name || '';
    const sessionKey = body.sessionKey || body.session_key || null;
    const phone = String(body.phone).replace(/\D/g, '').slice(-10);
    const email = body.email.trim().toLowerCase();

    const { row } = await upsertMarketingLead(pool, {
      fullName,
      email,
      phone,
      loanType: body.loanType || body.loan_type || null,
      source: body.source || 'eligibility',
      consentAccepted: Boolean(body.consentAccepted || body.consent_accepted),
      sessionKey,
      status: 'new',
    });

    await applyAgentCodeToLead(pool, row?.id, body);

    const settings = await getOtpProviderSettings();
    let otpResult;
    try {
      otpResult = await sendDualChannelOtp({ phone, email, settings, publicFacing: true });
    } catch (otpErr) {
      console.error('[leads:start-verification:otp]', otpErr?.message || otpErr);
      return res.status(502).json({ error: toPublicOtpMessage(otpErr?.message) });
    }
    const deliverySettings = effectiveOtpSettings(settings, otpResult);
    const otpIds = await persistLeadOtps(pool, {
      leadId: row.id,
      email,
      phone,
      settings: deliverySettings,
      mobileOtp: otpResult.mobileOtp,
      emailOtp: otpResult.emailOtp,
    });

    const [[fresh]] = await pool.execute(`SELECT * FROM marketing_leads WHERE id = :id`, {
      id: row.id,
    });

    res.status(200).json({
      ...formatOtpSendResponse({
        settings,
        mobileOtp: otpResult.mobileOtp,
        emailOtp: otpResult.emailOtp,
        otpIds,
        otpResult,
        publicFacing: true,
      }),
      lead: formatLead(fresh || row),
    });
  } catch (err) {
    next(err);
  }
});

leadsRouter.post('/call-consent/request-otp', authenticate, async (req, res, next) => {
  try {
    if (!['employee', 'agent', 'admin', 'super_admin'].includes(req.auth.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const phone = String(req.body?.mobile || req.body?.phone || '').replace(/\D/g, '').slice(-10);
    const { requestCallConsentOtp } = await import('../lib/callConsentOtp.js');
    res.json(await requestCallConsentOtp({ phone, initiatedByUserId: req.auth.userId }));
  } catch (err) {
    next(err);
  }
});

leadsRouter.post('/call-consent/verify-otp', authenticate, async (req, res, next) => {
  try {
    if (!['employee', 'agent', 'admin', 'super_admin'].includes(req.auth.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const phone = String(req.body?.mobile || req.body?.phone || '').replace(/\D/g, '').slice(-10);
    const otp = String(req.body?.otp || '').trim();
    const { verifyCallConsentOtp } = await import('../lib/callConsentOtp.js');
    res.json(await verifyCallConsentOtp({ phone, otp }));
  } catch (err) {
    next(err);
  }
});

leadsRouter.post('/request-otp', async (req, res, next) => {
  try {
    const { phone, email, leadId } = z
      .object({
        phone: z.string().min(10),
        email: z.string().email(),
        leadId: z.string().optional(),
      })
      .parse(req.body);

    const pool = getPool();
    const settings = await getOtpProviderSettings();

    let resolvedLeadId = leadId || null;
    if (!resolvedLeadId) {
      const existing = await findMarketingLeadByContact(pool, { email, phone });
      resolvedLeadId = existing?.id || null;
    }

    let otpResult;
    try {
      otpResult = await sendDualChannelOtp({
        phone,
        email,
        settings,
        publicFacing: true,
      });
    } catch (otpErr) {
      console.error('[leads:request-otp]', otpErr?.message || otpErr);
      return res.status(502).json({ error: toPublicOtpMessage(otpErr?.message) });
    }

    const deliverySettings = effectiveOtpSettings(settings, otpResult);
    const otpIds = await persistLeadOtps(pool, {
      leadId: resolvedLeadId,
      email,
      phone,
      settings: deliverySettings,
      mobileOtp: otpResult.mobileOtp,
      emailOtp: otpResult.emailOtp,
    });

    res.json(
      formatOtpSendResponse({
        settings,
        mobileOtp: otpResult.mobileOtp,
        emailOtp: otpResult.emailOtp,
        otpIds,
        otpResult,
        publicFacing: true,
      }),
    );
  } catch (err) {
    next(err);
  }
});

leadsRouter.post('/verify-otp', async (req, res, next) => {
  try {
    const body = z
      .object({
        phone: z.string().min(10),
        email: z.string().email(),
        mobileOtp: z.string().length(6).optional(),
        emailOtp: z.string().length(6).optional(),
        otp: z.string().length(6).optional(),
        leadId: z.string().optional(),
      })
      .parse(req.body);

    const pool = getPool();
    const phone = normalizeLeadPhone(body.phone);
    const email = body.email.trim().toLowerCase();

    // Verify against OTP rows that were actually issued (not Admin "required" flags alone).
    // If SMS delivery failed and only email OTP was stored, require email only — and vice versa.
    const [[pendingSms]] = await pool.execute(
      `SELECT id, lead_id, otp_hash FROM lead_otps
       WHERE ${sqlParamEquals('phone', 'phone')}
         AND ${sqlLiteralEquals('purpose', 'lead_verify')}
         AND ${sqlLiteralEquals('channel', 'sms')}
         AND verified_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      { phone },
    );
    const [[pendingEmail]] = await pool.execute(
      `SELECT id, lead_id, otp_hash FROM lead_otps
       WHERE ${sqlParamEquals('email', 'email')}
         AND ${sqlLiteralEquals('purpose', 'lead_verify')}
         AND ${sqlLiteralEquals('channel', 'email')}
         AND verified_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      { email },
    );

    const needMobile = Boolean(pendingSms);
    const needEmail = Boolean(pendingEmail);

    if (!needMobile && !needEmail) {
      return res.status(401).json({
        error: 'Invalid or expired OTP. Please request a new code.',
      });
    }

    const mobileCode =
      body.mobileOtp
      || (needMobile && !needEmail ? body.otp : undefined);
    const emailCode =
      body.emailOtp
      || (needEmail && !needMobile ? body.otp : undefined);

    if (needMobile && !mobileCode) {
      return res.status(400).json({ error: 'Mobile OTP is required.' });
    }
    if (needEmail && !emailCode) {
      return res.status(400).json({ error: 'Email OTP is required.' });
    }

    const devTestOtp =
      process.env.LOG_OTP === 'true'
      && (!needMobile || mobileCode === '123456')
      && (!needEmail || emailCode === '123456');

    let smsRow = null;
    let emailRow = null;

    if (needMobile) {
      if (devTestOtp || pendingSms.otp_hash === hashOtp(mobileCode)) {
        smsRow = pendingSms;
      } else {
        return res.status(401).json({ error: 'Invalid or expired mobile OTP.' });
      }
    }

    if (needEmail) {
      if (devTestOtp || pendingEmail.otp_hash === hashOtp(emailCode)) {
        emailRow = pendingEmail;
      } else {
        return res.status(401).json({ error: 'Invalid or expired email OTP.' });
      }
    }

    const idsToMark = [smsRow?.id, emailRow?.id].filter(Boolean);
    for (const id of idsToMark) {
      await pool.execute(`UPDATE lead_otps SET verified_at = NOW() WHERE id = :id`, { id });
    }

    const targetLeadId =
      body.leadId ||
      smsRow?.lead_id ||
      emailRow?.lead_id ||
      (await findMarketingLeadByContact(pool, {
        email,
        phone,
      }))?.id;
    if (targetLeadId) {
      await pool.execute(
        `UPDATE marketing_leads SET consent_verified_at = NOW(), status = 'verified' WHERE id = :id`,
        { id: targetLeadId },
      );
      const [[row]] = await pool.execute(`SELECT * FROM marketing_leads WHERE id = :id`, {
        id: targetLeadId,
      });
      return res.json({ verified: true, lead: formatLead(row) });
    }

    res.json({ verified: true });
  } catch (err) {
    next(err);
  }
});

leadsRouter.patch('/:id', async (req, res, next) => {
  try {
    const pool = getPool();
    const updates = req.body || {};
    const eligibilityData = updates.eligibilityData || updates.eligibility_data;
    let mergedEligibility = eligibilityData || null;

    if (eligibilityData) {
      try {
        const [[existing]] = await pool.execute(
          `SELECT eligibility_data FROM marketing_leads WHERE id = :id LIMIT 1`,
          { id: req.params.id },
        );
        const prev =
          typeof existing?.eligibility_data === 'object'
            ? existing.eligibility_data
            : existing?.eligibility_data
              ? JSON.parse(existing.eligibility_data)
              : {};
        mergedEligibility = { ...(prev || {}), ...eligibilityData };
      } catch {
        mergedEligibility = eligibilityData;
      }
    }

    await pool.execute(
      `UPDATE marketing_leads SET
         status = COALESCE(:status, status),
         eligibility_score = COALESCE(:score, eligibility_score),
         eligibility_data = COALESCE(:data, eligibility_data),
         application_id = COALESCE(:application_id, application_id),
         loan_type = COALESCE(:loan_type, loan_type),
         loan_amount = COALESCE(:loan_amount, loan_amount),
         employment_type = COALESCE(:employment_type, employment_type),
         updated_at = NOW()
       WHERE id = :id`,
      {
        id: req.params.id,
        status: updates.status ?? null,
        score: updates.eligibilityScore ?? updates.eligibility_score ?? null,
        data: mergedEligibility ? JSON.stringify(mergedEligibility) : null,
        application_id: updates.applicationId ?? updates.application_id ?? null,
        loan_type: updates.loanType ?? updates.loan_type ?? null,
        loan_amount:
          updates.loanAmount != null || updates.loan_amount != null
            ? Number(updates.loanAmount ?? updates.loan_amount)
            : null,
        employment_type: updates.employmentType ?? updates.employment_type ?? null,
      },
    );

    const [[row]] = await pool.execute(`SELECT * FROM marketing_leads WHERE id = :id`, {
      id: req.params.id,
    });
    if (!row) return res.status(404).json({ error: 'Lead not found' });
    res.json(formatLead(row));
  } catch (err) {
    next(err);
  }
});

leadsRouter.post('/drafts', async (req, res, next) => {
  try {
    const body = z
      .object({
        sessionKey: z.string().min(8),
        formData: z.record(z.unknown()),
        currentStep: z.number().int().min(0).optional(),
        loanType: z.string().optional(),
        preferredBankId: z.string().optional(),
        loanPriority: z.string().optional(),
        applicationId: z.string().optional(),
      })
      .parse(req.body);

    const pool = getPool();
    const [[existing]] = await pool.execute(
      `SELECT id FROM application_form_drafts WHERE session_key = :sk LIMIT 1`,
      { sk: body.sessionKey },
    );

    if (existing) {
      await pool.execute(
        `UPDATE application_form_drafts SET
           form_data = :data,
           current_step = :step,
           loan_type = COALESCE(:loan_type, loan_type),
           preferred_bank_id = COALESCE(:bank_id, preferred_bank_id),
           loan_priority = COALESCE(:priority, loan_priority),
           application_id = COALESCE(:app_id, application_id)
         WHERE session_key = :sk`,
        {
          sk: body.sessionKey,
          data: JSON.stringify(body.formData),
          step: body.currentStep ?? 0,
          loan_type: body.loanType ?? null,
          bank_id: body.preferredBankId ?? null,
          priority: body.loanPriority ?? null,
          app_id: body.applicationId ?? null,
        },
      );
    } else {
      const id = newId();
      await pool.execute(
        `INSERT INTO application_form_drafts (
           id, session_key, form_data, current_step, loan_type, preferred_bank_id, loan_priority, application_id
         ) VALUES (
           :id, :sk, :data, :step, :loan_type, :bank_id, :priority, :app_id
         )`,
        {
          id,
          sk: body.sessionKey,
          data: JSON.stringify(body.formData),
          step: body.currentStep ?? 0,
          loan_type: body.loanType ?? null,
          bank_id: body.preferredBankId ?? null,
          priority: body.loanPriority ?? null,
          app_id: body.applicationId ?? null,
        },
      );
    }

    const leadId = await upsertLeadFromDraft({
      sessionKey: body.sessionKey,
      formData: body.formData,
      loanType: body.loanType,
      currentStep: body.currentStep,
      applicationId: body.applicationId,
    });

    res.json({ ok: true, sessionKey: body.sessionKey, leadId });
  } catch (err) {
    next(err);
  }
});

leadsRouter.post('/drafts/resume-link', async (req, res, next) => {
  try {
    const body = z
      .object({
        sessionKey: z.string().min(8),
        leadId: z.string().optional(),
        frontendOrigin: z.string().url().optional(),
        sendNotification: z.boolean().optional(),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        channel: z.enum(['email', 'sms', 'whatsapp']).optional(),
      })
      .parse(req.body);

    const pool = getPool();
    const [[draft]] = await pool.execute(
      `SELECT session_key FROM application_form_drafts WHERE session_key = :sk LIMIT 1`,
      { sk: body.sessionKey },
    );
    if (!draft) {
      return res.status(404).json({ error: 'No saved draft for this session' });
    }

    const link = await createResumeToken({
      sessionKey: body.sessionKey,
      leadId: body.leadId,
      frontendOrigin: body.frontendOrigin,
    });

    if (body.sendNotification && (body.email || body.phone)) {
      const message = `Continue your Rfincare application: ${link.url}`;
      await sendOtpNotification({
        email: body.email,
        phone: body.phone,
        otp: message,
        channel: body.channel || 'email',
      });
    }

    res.json({
      url: link.url,
      expiresAt: link.expiresAt,
      ...(process.env.LOG_OTP === 'true' ? { devToken: link.token } : {}),
    });
  } catch (err) {
    if (isNoSuchTableError(err)) {
      err.status = 503;
      err.message = 'Run migration 008_milestone2_resume_tokens.sql';
    }
    next(err);
  }
});

leadsRouter.post('/:id/resume-link', authenticate, async (req, res, next) => {
  try {
    const role = req.auth.role;
    if (!hasPermission(role, 'manage:*') && role !== 'admin' && role !== 'super_admin' && role !== 'employee') {
      const e = new Error('Insufficient permissions');
      e.status = 403;
      throw e;
    }

    const pool = getPool();
    const [[lead]] = await pool.execute(`SELECT * FROM marketing_leads WHERE id = :id`, {
      id: req.params.id,
    });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const body = z
      .object({
        frontendOrigin: z.string().max(512).optional(),
        sendNotification: z.boolean().optional(),
        channel: z.enum(['email', 'sms', 'whatsapp']).optional(),
      })
      .parse(req.body || {});

    const sessionKey = await ensureLeadDraftSession(pool, lead);

    const link = await createResumeToken({
      sessionKey,
      leadId: lead.id,
      frontendOrigin: body.frontendOrigin,
    });

    if (body.sendNotification) {
      const message = `Continue your Rfincare application: ${link.url}`;
      await sendOtpNotification({
        email: lead.email,
        phone: lead.phone,
        otp: message,
        channel: body.channel || 'email',
      });
    }

    res.json({ url: link.url, expiresAt: link.expiresAt, lead: formatLead(lead) });
  } catch (err) {
    next(err);
  }
});

leadsRouter.get('/drafts/:sessionKey', async (req, res, next) => {
  try {
    const pool = getPool();
    const [[row]] = await pool.execute(
      `SELECT * FROM application_form_drafts WHERE session_key = :sk LIMIT 1`,
      { sk: req.params.sessionKey },
    );
    if (!row) return res.json(null);

    res.json({
      sessionKey: row.session_key,
      formData: JSON.parse(row.form_data || '{}'),
      currentStep: row.current_step,
      loanType: row.loan_type,
      preferredBankId: row.preferred_bank_id,
      loanPriority: row.loan_priority,
      applicationId: row.application_id,
      updatedAt: row.updated_at,
    });
  } catch (err) {
    next(err);
  }
});

leadsRouter.get('/export.csv', authenticate, async (req, res, next) => {
  try {
    const role = req.auth.role;
    if (!canReadLeads(role)) {
      const e = new Error('Insufficient permissions');
      e.status = 403;
      throw e;
    }

    await ensureOnboardingSchema();
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT ml.*,
              up.full_name AS assignee_name,
              up.role AS assignee_role,
              COALESCE(ao.agent_code, eo.employee_code) AS assignee_code
       FROM marketing_leads ml
       LEFT JOIN user_profiles up ON up.id = ml.assigned_to
       LEFT JOIN agent_onboarding ao ON ao.user_id = up.id AND up.role = 'agent'
       LEFT JOIN employee_onboarding eo ON eo.user_id = up.id AND up.role = 'employee'
       ORDER BY ml.created_at DESC`,
    );

    const header = [
      'Lead ID',
      'Full Name',
      'Email',
      'Phone',
      'Product Type',
      'Source',
      'Status',
      'Eligibility Score',
      'Application ID',
      'Assigned To',
      'Assigned Code',
      'Assigned Role',
      'Assignment Method',
      'First Contact Due At',
      'First Contact At',
      'First Contact Channel',
      'TAT Minutes',
      'TAT Status',
      'Consent Accepted',
      'Consent Verified At',
      'Created At',
      'Updated At',
    ];

    const lines = rows.map((row) => [
      row.id,
      row.full_name,
      row.email,
      row.phone,
      formatProductType(row.loan_type),
      row.source,
      row.status,
      row.eligibility_score,
      row.application_id,
      row.assignee_name,
      row.assignee_code,
      row.assignee_role,
      row.assignment_method,
      row.first_contact_due_at,
      row.first_contact_at,
      row.first_contact_channel,
      row.tat_minutes,
      row.tat_status,
      row.consent_accepted ? 'Yes' : 'No',
      row.consent_verified_at,
      row.created_at,
      row.updated_at,
    ].map(csvEscape).join(','));

    const csv = [header.map(csvEscape).join(','), ...lines].join('\n');
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="rfincare-product-leads-${stamp}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

leadsRouter.get('/', authenticate, async (req, res, next) => {
  try {
    const role = req.auth.role;
    if (!canReadLeads(role)) {
      const e = new Error('Insufficient permissions');
      e.status = 403;
      throw e;
    }

    await ensureOnboardingSchema();
    const pool = getPool();
    await ensureLeadAssignmentSchema(pool).catch(() => {});
    await processTatMissReassignments(pool, { limit: 25 }).catch(() => null);
    const tatSettings = await getLeadAssignmentSettings(pool).catch(() => null);

    const assignedFilter = req.query.assignedTo || req.query.assigned_to;
    const monthFilter = String(req.query.month || '').trim();
    const dateFrom = String(req.query.dateFrom || req.query.date_from || '').trim();
    const dateTo = String(req.query.dateTo || req.query.date_to || '').trim();
    const where = [];
    const params = {};

    if (assignedFilter === 'me') {
      if (role === 'employee' || role === 'agent') {
        where.push('ml.assigned_to = :userId');
        params.userId = req.auth.userId;
      } else if (role !== 'admin' && role !== 'super_admin') {
        const e = new Error('assignedTo=me is only for employees and agents');
        e.status = 400;
        throw e;
      }
    } else if (assignedFilter === 'team' && role === 'employee') {
      // L2/L3 supervisors see all leads (same visibility as admin for ops follow-up).
      const scope = await resolveEmployeeLeadScope(pool, req.auth.userId);
      if (scope.scope !== 'team') {
        where.push('ml.assigned_to = :userId');
        params.userId = req.auth.userId;
      }
    } else if (!assignedFilter && role === 'employee') {
      // Default employee view: L1 = mine; L2/L3 = all (shared visibility with admin).
      const scope = await resolveEmployeeLeadScope(pool, req.auth.userId);
      if (scope.scope === 'assigned') {
        where.push('ml.assigned_to = :userId');
        params.userId = req.auth.userId;
      }
    }

    if (monthFilter) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthFilter)) {
        return res.status(400).json({ error: 'month must be in YYYY-MM format' });
      }
      where.push(
        `to_char(GREATEST(ml.created_at, ml.updated_at) AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = :monthFilter`,
      );
      params.monthFilter = monthFilter;
    }

    if (dateFrom) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
        return res.status(400).json({ error: 'dateFrom must be in YYYY-MM-DD format' });
      }
      where.push(
        `(GREATEST(ml.created_at, ml.updated_at) AT TIME ZONE 'Asia/Kolkata')::date >= CAST(:dateFrom AS date)`,
      );
      params.dateFrom = dateFrom;
    }

    if (dateTo) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
        return res.status(400).json({ error: 'dateTo must be in YYYY-MM-DD format' });
      }
      where.push(
        `(GREATEST(ml.created_at, ml.updated_at) AT TIME ZONE 'Asia/Kolkata')::date <= CAST(:dateTo AS date)`,
      );
      params.dateTo = dateTo;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limitSql = canManageLeads(role) ? 'LIMIT 5000' : 'LIMIT 500';

    const [rows] = await pool.execute(
      `SELECT ml.*,
              up.full_name AS assignee_name,
              up.role AS assignee_role,
              COALESCE(ao.agent_code, eo.employee_code) AS assignee_code
       FROM marketing_leads ml
       LEFT JOIN user_profiles up ON up.id = ml.assigned_to
       LEFT JOIN agent_onboarding ao ON ao.user_id = up.id AND up.role = 'agent'
       LEFT JOIN employee_onboarding eo ON eo.user_id = up.id AND up.role = 'employee'
       ${whereSql}
       ORDER BY GREATEST(ml.created_at, ml.updated_at) DESC
       ${limitSql}`,
      params,
    );
    res.json(rows.map((row) => formatLead(row, tatSettings)));
  } catch (err) {
    next(err);
  }
});

const EMPLOYEE_LEAD_STATUSES = new Set([
  'contacted',
  'interested',
  'follow_up',
  'documents_required',
  'converted',
  'closed',
  'in_progress',
  'lost',
]);

leadsRouter.patch('/:id/status', authenticate, async (req, res, next) => {
  try {
    const role = req.auth.role;
    const status = String(req.body?.status || '').toLowerCase();
    if (!status || !EMPLOYEE_LEAD_STATUSES.has(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const pool = getPool();
    const [[lead]] = await pool.execute(`SELECT * FROM marketing_leads WHERE id = :id`, {
      id: req.params.id,
    });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const isAdmin = role === 'admin' || role === 'super_admin' || hasPermission(role, 'manage:*');
    const isAssignee = lead.assigned_to === req.auth.userId;
    let teamAccess = false;
    if (role === 'employee' && !isAssignee) {
      const scope = await resolveEmployeeLeadScope(pool, req.auth.userId);
      teamAccess = scope.scope === 'team';
    }
    if (!isAdmin && !(role === 'employee' && (isAssignee || teamAccess))) {
      const e = new Error('Insufficient permissions');
      e.status = 403;
      throw e;
    }

    await pool.execute(
      `UPDATE marketing_leads SET status = :status WHERE id = :id`,
      { id: req.params.id, status },
    );

    const [[row]] = await pool.execute(
      `SELECT ml.*,
              up.full_name AS assignee_name,
              up.role AS assignee_role,
              COALESCE(ao.agent_code, eo.employee_code) AS assignee_code
       FROM marketing_leads ml
       LEFT JOIN user_profiles up ON up.id = ml.assigned_to
       LEFT JOIN agent_onboarding ao ON ao.user_id = up.id AND up.role = 'agent'
       LEFT JOIN employee_onboarding eo ON eo.user_id = up.id AND up.role = 'employee'
       WHERE ml.id = :id`,
      { id: req.params.id },
    );
    res.json(formatLead(row));
  } catch (err) {
    next(err);
  }
});

leadsRouter.patch('/:id/assign', authenticate, async (req, res, next) => {
  try {
    const role = req.auth.role;
    if (!canManageLeads(role)) {
      const e = new Error('Insufficient permissions');
      e.status = 403;
      throw e;
    }
    const assigneeId = req.body?.assignedTo || req.body?.assigned_to || null;
    const pool = getPool();
    await ensureLeadAssignmentSchema(pool).catch(() => {});

    let sourcedAgentCode = null;
    if (assigneeId) {
      const [[assignee]] = await pool.execute(
        `SELECT up.id, up.role, ao.agent_code
         FROM user_profiles up
         LEFT JOIN agent_onboarding ao ON ao.user_id = up.id
         WHERE up.id = :id
         LIMIT 1`,
        { id: assigneeId },
      );
      if (!assignee) {
        return res.status(400).json({ error: 'Assignee not found' });
      }
      if (String(assignee.role || '').toLowerCase() === 'agent') {
        sourcedAgentCode =
          (await ensureAgentCodeForUser(pool, assigneeId))
          || String(assignee.agent_code || '').trim()
          || null;
      }
    }

    // Stamp sourced_agent_code when assigning to an agent so the lead appears
    // in that agent's Client Pipeline (which keys off agent code + assigned_to).
    if (assigneeId && sourcedAgentCode) {
      await pool.execute(
        `UPDATE marketing_leads
         SET assigned_to = :assignee,
             status = 'assigned',
             sourced_agent_code = :code,
             assignment_method = 'manual'
         WHERE id = :id`,
        { id: req.params.id, assignee: assigneeId, code: sourcedAgentCode },
      );
    } else {
      await pool.execute(
        `UPDATE marketing_leads
         SET assigned_to = :assignee,
             status = CASE WHEN :assignee IS NULL THEN status ELSE 'assigned' END,
             assignment_method = CASE WHEN :assignee IS NULL THEN assignment_method ELSE 'manual' END
         WHERE id = :id`,
        { id: req.params.id, assignee: assigneeId },
      );
    }

    if (assigneeId) {
      await ensureLeadTatClock(pool, req.params.id).catch(() => {});
      await recordLeadActivity(pool, {
        leadId: req.params.id,
        actorUserId: req.auth.userId,
        activityType: 'assigned',
        channel: 'manual',
        notes: 'Manually assigned',
        meta: { assigneeId },
      }).catch(() => {});
    }

    const [[row]] = await pool.execute(
      `SELECT ml.*,
              up.full_name AS assignee_name,
              up.role AS assignee_role,
              COALESCE(ao.agent_code, eo.employee_code) AS assignee_code
       FROM marketing_leads ml
       LEFT JOIN user_profiles up ON up.id = ml.assigned_to
       LEFT JOIN agent_onboarding ao ON ao.user_id = up.id AND up.role = 'agent'
       LEFT JOIN employee_onboarding eo ON eo.user_id = up.id AND up.role = 'employee'
       WHERE ml.id = :id`,
      { id: req.params.id },
    );
    res.json(formatLead(row));
  } catch (err) {
    next(err);
  }
});

async function assertLeadOpsAccess(pool, auth, lead) {
  const role = auth.role;
  if (role === 'admin' || role === 'super_admin' || hasPermission(role, 'manage:*')) return;
  if (role === 'employee') {
    if (lead.assigned_to === auth.userId) return;
    const scope = await resolveEmployeeLeadScope(pool, auth.userId);
    if (scope.scope === 'team') return;
  }
  if (role === 'agent' && lead.assigned_to === auth.userId) return;
  const e = new Error('Insufficient permissions');
  e.status = 403;
  throw e;
}

leadsRouter.post('/:id/contact', authenticate, async (req, res, next) => {
  try {
    const role = req.auth.role;
    if (!canReadLeads(role)) {
      const e = new Error('Insufficient permissions');
      e.status = 403;
      throw e;
    }
    const channel = String(req.body?.channel || '').toLowerCase();
    const notes = req.body?.notes ? String(req.body.notes).slice(0, 2000) : null;
    const outcome = req.body?.outcome || 'attempted';
    const templateUsed = req.body?.templateUsed || req.body?.template_used || null;
    const pool = getPool();
    const [[lead]] = await pool.execute(`SELECT * FROM marketing_leads WHERE id = :id`, {
      id: req.params.id,
    });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    await assertLeadOpsAccess(pool, req.auth, lead);

    const fresh = await recordLeadContact(pool, {
      leadId: req.params.id,
      actorUserId: req.auth.userId,
      channel,
      notes,
      outcome,
      templateUsed,
    });
    const settings = await getLeadAssignmentSettings(pool).catch(() => null);
    res.json(formatLead(fresh, settings));
  } catch (err) {
    next(err);
  }
});

leadsRouter.get('/:id/activities', authenticate, async (req, res, next) => {
  try {
    const role = req.auth.role;
    if (!canReadLeads(role)) {
      const e = new Error('Insufficient permissions');
      e.status = 403;
      throw e;
    }
    const pool = getPool();
    const [[lead]] = await pool.execute(`SELECT * FROM marketing_leads WHERE id = :id`, {
      id: req.params.id,
    });
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    await assertLeadOpsAccess(pool, req.auth, lead);

    const rows = await listLeadActivities(pool, req.params.id, {
      limit: Number(req.query.limit) || 50,
    });
    res.json(
      (rows || []).map((r) => ({
        id: r.id,
        leadId: r.lead_id,
        actorUserId: r.actor_user_id,
        actorName: r.actor_name || null,
        actorRole: r.actor_role || null,
        activityType: r.activity_type,
        channel: r.channel,
        notes: r.notes,
        meta:
          typeof r.meta_json === 'object'
            ? r.meta_json
            : r.meta_json
              ? JSON.parse(r.meta_json)
              : null,
        createdAt: r.created_at,
      })),
    );
  } catch (err) {
    next(err);
  }
});

leadsRouter.delete('/:id', authenticate, async (req, res, next) => {
  try {
    if (!canManageLeads(req.auth.role)) {
      const e = new Error('Only admin can delete leads');
      e.status = 403;
      throw e;
    }
    const pool = getPool();
    const [result] = await pool.execute(`DELETE FROM marketing_leads WHERE id = :id`, {
      id: req.params.id,
    });
    if (!result?.affectedRows) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    res.json({ success: true, deletedCount: 1 });
  } catch (err) {
    next(err);
  }
});

leadsRouter.post('/bulk-delete', authenticate, async (req, res, next) => {
  try {
    if (!canManageLeads(req.auth.role)) {
      const e = new Error('Only admin can delete leads');
      e.status = 403;
      throw e;
    }
    const ids = Array.isArray(req.body?.leadIds) ? req.body.leadIds.map((v) => String(v || '').trim()).filter(Boolean) : [];
    if (!ids.length) {
      return res.status(400).json({ error: 'leadIds is required' });
    }
    const pool = getPool();
    const params = {};
    const placeholders = ids.map((id, idx) => {
      const key = `id_${idx}`;
      params[key] = id;
      return `:${key}`;
    });
    const [result] = await pool.execute(
      `DELETE FROM marketing_leads WHERE id IN (${placeholders.join(', ')})`,
      params,
    );
    res.json({ success: true, deletedCount: Number(result?.affectedRows || 0) });
  } catch (err) {
    next(err);
  }
});
