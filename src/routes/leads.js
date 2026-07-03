import { Router } from 'express';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { ensureOnboardingSchema } from '../db/ensureOnboardingSchema.js';
import { newId } from '../lib/ids.js';
import { hashOtp, sendDualChannelOtp, sendOtpNotification } from '../lib/otp.js';
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
import { authenticate } from '../middleware/authenticate.js';
import { hasPermission } from '../auth/permissions.js';

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

function formatLead(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    full_name: row.full_name,
    email: row.email,
    phone: row.phone,
    loanType: row.loan_type,
    loan_type: row.loan_type,
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
    sourcedAgentCode: row.sourced_agent_code || null,
    applicationId: row.application_id,
    sessionKey: row.session_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CreateLeadSchema = z.object({
  fullName: z.string().min(1).optional(),
  full_name: z.string().min(1).optional(),
  email: z.string().email(),
  phone: z.string().min(10),
  loanType: z.string().optional(),
  loan_type: z.string().optional(),
  source: z.string().optional(),
  consentAccepted: z.boolean().optional(),
  consent_accepted: z.boolean().optional(),
  sessionKey: z.string().optional(),
  session_key: z.string().optional(),
  sourcedAgentCode: z.string().optional().nullable(),
  sourced_agent_code: z.string().optional().nullable(),
  agentCode: z.string().optional().nullable(),
});

async function applyAgentCodeToLead(pool, leadId, body) {
  const agentCode = normalizeAgentCode(
    body.sourcedAgentCode || body.sourced_agent_code || body.agentCode,
  );
  if (!agentCode || !leadId) return;
  try {
    await pool.execute(
      `UPDATE marketing_leads SET sourced_agent_code = :code WHERE id = :id`,
      { code: agentCode, id: leadId },
    );
  } catch {
    /* column may not exist until migration */
  }
}

leadsRouter.post('/', async (req, res, next) => {
  try {
    const body = CreateLeadSchema.parse(req.body);
    const pool = getPool();
    const fullName = body.fullName || body.full_name || '';
    const sessionKey = body.sessionKey || body.session_key || null;

    const { row, created } = await upsertMarketingLead(pool, {
      fullName,
      email: body.email,
      phone: body.phone,
      loanType: body.loanType || body.loan_type || null,
      source: body.source || 'eligibility',
      consentAccepted: Boolean(body.consentAccepted || body.consent_accepted),
      sessionKey,
      status: 'new',
    });

    await applyAgentCodeToLead(pool, row?.id, body);

    res.status(created ? 201 : 200).json({ ...formatLead(row), created, updated: !created });
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

function formatOtpSendResponse({ settings, mobileOtp, emailOtp, otpIds, warnings = [], otpResult }) {
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
    smsProvider: settings.smsProvider,
    emailProvider: settings.emailProvider,
    warnings: warnings.length ? warnings : undefined,
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
    const body = CreateLeadSchema.parse(req.body);
    const pool = getPool();
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
    const otpResult = await sendDualChannelOtp({ phone, email, settings });
    const deliverySettings = effectiveOtpSettings(settings, otpResult);
    const otpIds = await persistLeadOtps(pool, {
      leadId: row.id,
      email,
      phone,
      settings: deliverySettings,
      mobileOtp: otpResult.mobileOtp,
      emailOtp: otpResult.emailOtp,
    });

    res.status(200).json({
      ...formatOtpSendResponse({
        settings,
        mobileOtp: otpResult.mobileOtp,
        emailOtp: otpResult.emailOtp,
        otpIds,
        warnings: otpResult.warnings,
        otpResult,
      }),
      lead: formatLead(row),
    });
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

    const otpResult = await sendDualChannelOtp({
      phone,
      email,
      settings,
    });

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
        warnings: otpResult.warnings,
        otpResult,
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

    const settings = await getOtpProviderSettings();
    const mobileCode = body.mobileOtp || (settings.requireEmailOtp === false ? body.otp : undefined);
    const emailCode = body.emailOtp || (settings.requireMobileOtp === false ? body.otp : undefined);

    if (settings.requireMobileOtp && !mobileCode) {
      return res.status(400).json({ error: 'Mobile OTP is required.' });
    }
    if (settings.requireEmailOtp && !emailCode) {
      return res.status(400).json({ error: 'Email OTP is required.' });
    }

    const pool = getPool();
    let smsRow = null;
    let emailRow = null;

    const phone = normalizeLeadPhone(body.phone);
    const email = body.email.trim().toLowerCase();

    const devTestOtp =
      process.env.LOG_OTP === 'true' &&
      (!settings.requireMobileOtp || mobileCode === '123456') &&
      (!settings.requireEmailOtp || emailCode === '123456');

    if (settings.requireMobileOtp && mobileCode) {
      const [[row]] = await pool.execute(
        devTestOtp
          ? `SELECT id, lead_id FROM lead_otps
             WHERE ${sqlParamEquals('phone', 'phone')}
               AND ${sqlLiteralEquals('purpose', 'lead_verify')}
               AND ${sqlLiteralEquals('channel', 'sms')}
               AND verified_at IS NULL AND expires_at > NOW()
             ORDER BY created_at DESC LIMIT 1`
          : `SELECT id, lead_id FROM lead_otps
             WHERE ${sqlParamEquals('phone', 'phone')}
               AND ${sqlParamEquals('otp_hash', 'hash')}
               AND ${sqlLiteralEquals('purpose', 'lead_verify')}
               AND ${sqlLiteralEquals('channel', 'sms')}
               AND verified_at IS NULL AND expires_at > NOW()
             ORDER BY created_at DESC LIMIT 1`,
        devTestOtp
          ? { phone }
          : { phone, hash: hashOtp(mobileCode) },
      );
      smsRow = row;
      if (!smsRow) {
        return res.status(401).json({ error: 'Invalid or expired mobile OTP.' });
      }
    }

    if (settings.requireEmailOtp && emailCode) {
      const [[row]] = await pool.execute(
        devTestOtp
          ? `SELECT id, lead_id FROM lead_otps
             WHERE ${sqlParamEquals('email', 'email')}
               AND ${sqlLiteralEquals('purpose', 'lead_verify')}
               AND ${sqlLiteralEquals('channel', 'email')}
               AND verified_at IS NULL AND expires_at > NOW()
             ORDER BY created_at DESC LIMIT 1`
          : `SELECT id, lead_id FROM lead_otps
             WHERE ${sqlParamEquals('email', 'email')}
               AND ${sqlParamEquals('otp_hash', 'hash')}
               AND ${sqlLiteralEquals('purpose', 'lead_verify')}
               AND ${sqlLiteralEquals('channel', 'email')}
               AND verified_at IS NULL AND expires_at > NOW()
             ORDER BY created_at DESC LIMIT 1`,
        devTestOtp
          ? { email }
          : { email, hash: hashOtp(emailCode) },
      );
      emailRow = row;
      if (!emailRow) {
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

    await pool.execute(
      `UPDATE marketing_leads SET
         status = COALESCE(:status, status),
         eligibility_score = COALESCE(:score, eligibility_score),
         eligibility_data = COALESCE(:data, eligibility_data),
         application_id = COALESCE(:application_id, application_id)
       WHERE id = :id`,
      {
        id: req.params.id,
        status: updates.status ?? null,
        score: updates.eligibilityScore ?? updates.eligibility_score ?? null,
        data: eligibilityData ? JSON.stringify(eligibilityData) : null,
        application_id: updates.applicationId ?? updates.application_id ?? null,
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
    const assignedFilter = req.query.assignedTo || req.query.assigned_to;
    let whereSql = '';
    const params = {};

    if (assignedFilter === 'me') {
      if (role === 'employee' || role === 'agent') {
        whereSql = 'WHERE ml.assigned_to = :userId';
        params.userId = req.auth.userId;
      } else if (role !== 'admin' && role !== 'super_admin') {
        const e = new Error('assignedTo=me is only for employees and agents');
        e.status = 400;
        throw e;
      }
    }

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
       ORDER BY ml.created_at DESC
       LIMIT 200`,
      params,
    );
    res.json(rows.map(formatLead));
  } catch (err) {
    next(err);
  }
});

const EMPLOYEE_LEAD_STATUSES = new Set(['contacted', 'converted', 'closed', 'in_progress']);

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
    if (!isAdmin && !(role === 'employee' && isAssignee)) {
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
    if (!hasPermission(role, 'manage:*') && role !== 'admin' && role !== 'super_admin') {
      const e = new Error('Insufficient permissions');
      e.status = 403;
      throw e;
    }
    const assigneeId = req.body?.assignedTo || req.body?.assigned_to;
    const pool = getPool();
    await pool.execute(
      `UPDATE marketing_leads SET assigned_to = :assignee, status = 'assigned' WHERE id = :id`,
      { id: req.params.id, assignee: assigneeId },
    );
    const [[row]] = await pool.execute(`SELECT * FROM marketing_leads WHERE id = :id`, {
      id: req.params.id,
    });
    res.json(formatLead(row));
  } catch (err) {
    next(err);
  }
});
