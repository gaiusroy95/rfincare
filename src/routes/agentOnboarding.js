import crypto from 'node:crypto';
import { Router } from 'express';
import { join, basename } from 'node:path';
import { mkdirSync } from 'node:fs';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { ensureAgentOnboardingSchema } from '../db/ensureAgentOnboardingSchema.js';
import { newId } from '../lib/ids.js';
import { getUploadDir } from '../lib/uploadPaths.js';
import { createUploadMiddleware, spreadUpload } from '../lib/multerUpload.js';
import {
  generateOtp,
  hashOtp,
  isWhatsappOtpAvailable,
  sendOtpNotification,
  sendPublicOtpFailure,
} from '../lib/otp.js';
import { getOtpProviderSettings } from '../lib/otpProviderSettings.js';
import {
  assertOtpVerifyAllowed,
  canExposeDevOtp,
  clearOtpVerifyFailures,
  invalidOtpError,
  otpSecurityLimits,
  otpTargetKeys,
} from '../lib/otpSecurity.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { authenticate } from '../middleware/authenticate.js';
import { assertEmployeeAccess } from '../lib/employeeAccessControls.js';
import { toStoredPath, normalizeStorageKey } from '../lib/storage/keys.js';
import {
  acceptAgreements,
  adminGetApplication,
  adminListApplications,
  adminTransition,
  applicantLogin,
  createDraftApplication,
  EMPLOYEE_REVIEW_ACTIONS,
  issueApplicantAccessToken,
  listApplicationActions,
  listChecklistForEntity,
  loadApplicationBundle,
  patchDocumentById,
  replaceChecklistTemplates,
  saveBank,
  setDocumentFile,
  submitApplication,
  updateEntity,
  upsertParties,
} from '../lib/agentOnboarding.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { streamStoredUpload } from '../lib/uploadPaths.js';

export const agentOnboardingRouter = Router();

const OTP_PURPOSE = 'agent_onboarding_signup';
const OTP_PURPOSE_OK = 'agent_onboarding_signup_ok';
const TOKEN_TTL_MS = 30 * 60 * 1000;

function hmacSecret() {
  return process.env.JWT_ACCESS_SECRET || process.env.OTP_HMAC_SECRET || 'rfincare-agent-onboarding';
}

function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.toString()?.split(',')?.[0]?.trim()
    || req.socket?.remoteAddress
    || null
  );
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function buildConsentToken({ target, otpId, channel }) {
  return crypto
    .createHmac('sha256', hmacSecret())
    .update(`${channel}|${target}|${otpId}|agent_onboarding`)
    .digest('hex');
}

async function assertSignupConsent({ phone, email, consentToken, otpId, channel }) {
  if (!consentToken || !otpId) {
    const e = new Error('OTP verification is required before signup');
    e.status = 400;
    throw e;
  }
  const ch = String(channel || 'sms').toLowerCase();
  const target = ch === 'email' ? normalizeEmail(email) : normalizePhone(phone);
  const expected = buildConsentToken({ target, otpId, channel: ch });
  if (expected !== String(consentToken)) {
    const e = new Error('Invalid OTP consent token. Please verify OTP again.');
    e.status = 400;
    throw e;
  }

  const pool = getPool();
  const [[row]] = await pool.execute(
    `SELECT id, verified_at, purpose, phone, email, created_at
     FROM lead_otps WHERE id = :id LIMIT 1`,
    { id: otpId },
  );
  if (!row?.verified_at || !String(row.purpose || '').startsWith(OTP_PURPOSE)) {
    const e = new Error('Signup OTP not verified');
    e.status = 400;
    throw e;
  }
  if (ch === 'email') {
    if (normalizeEmail(row.email) !== target) {
      const e = new Error('OTP email mismatch');
      e.status = 400;
      throw e;
    }
  } else if (normalizePhone(row.phone) !== target) {
    const e = new Error('OTP phone mismatch');
    e.status = 400;
    throw e;
  }
  const ageMs = Date.now() - new Date(row.verified_at).getTime();
  if (ageMs > TOKEN_TTL_MS) {
    const e = new Error('OTP consent expired. Send OTP again.');
    e.status = 400;
    throw e;
  }
  return true;
}

/** Applicant JWT: role agent_applicant, sub = application UUID (no user_profiles row). */
async function authenticateApplicant(req, _res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
    if (!token) {
      const e = new Error('Missing access token');
      e.status = 401;
      throw e;
    }
    const payload = verifyAccessToken(token);
    if (payload?.role !== 'agent_applicant') {
      const e = new Error('Applicant access required');
      e.status = 403;
      throw e;
    }
    const applicationId = payload.applicationId || payload.sub;
    if (!applicationId) {
      const e = new Error('Invalid applicant token');
      e.status = 401;
      throw e;
    }
    await ensureAgentOnboardingSchema();
    const application = await loadApplicationBundle(applicationId);
    if (!application) {
      const e = new Error('Application not found');
      e.status = 404;
      throw e;
    }
    if (['suspended'].includes(String(application.workflowStatus || ''))) {
      const e = new Error('Application is suspended');
      e.status = 403;
      throw e;
    }
    req.auth = {
      userId: applicationId,
      applicationId,
      role: 'agent_applicant',
      email: application.email,
      application,
    };
    next();
  } catch (err) {
    if (err?.name === 'TokenExpiredError' || err?.name === 'JsonWebTokenError') {
      const e = new Error('Unauthorized');
      e.status = 401;
      return next(e);
    }
    next(err);
  }
}

function canManage(role) {
  return role === 'admin' || role === 'super_admin';
}

function requireCanManage(req, _res, next) {
  if (!req.auth || !canManage(req.auth.role)) {
    const e = new Error('Insufficient permissions');
    e.status = 403;
    return next(e);
  }
  next();
}

/** Admin always; employee needs agents ACL (and assignment for write actions). */
async function requireCanReview(req, _res, next) {
  try {
    if (!req.auth) {
      const e = new Error('Authentication required');
      e.status = 401;
      throw e;
    }
    if (canManage(req.auth.role)) {
      req.reviewContext = { role: 'admin', allowAdminOnlyActions: true };
      return next();
    }
    if (req.auth.role === 'employee') {
      await assertEmployeeAccess(req, 'agents', 'read');
      req.reviewContext = { role: 'employee', allowAdminOnlyActions: false };
      return next();
    }
    const e = new Error('Insufficient permissions');
    e.status = 403;
    throw e;
  } catch (err) {
    next(err);
  }
}

async function assertEmployeeCanAccessApplication(req, application) {
  if (canManage(req.auth.role)) return;
  if (req.auth.role !== 'employee') {
    const e = new Error('Insufficient permissions');
    e.status = 403;
    throw e;
  }
  const assignedTo = String(application?.assignedEmployeeId || '');
  if (assignedTo && assignedTo === String(req.auth.userId)) return;
  // Unassigned queue visible for pick-up/read when employee has agents write? Keep read for assigned only,
  // but allow listing unassigned so admin assign isn't the only path — employees see only assigned.
  if (!assignedTo) {
    const e = new Error('Application is not assigned to you');
    e.status = 403;
    throw e;
  }
  const e = new Error('Application is assigned to another employee');
  e.status = 403;
  throw e;
}

const uploadDirName = 'agent-onboarding';
const upload = createUploadMiddleware({
  subfolder: uploadDirName,
  maxBytes: 15 * 1024 * 1024,
});

function storedPath(file) {
  if (!file) return null;
  const key = normalizeStorageKey(file.storedPath || file.filename || file.storageKey);
  if (!key) return file.storedPath || null;
  // Disk multer stores under subfolder but may omit it from the key.
  if (!key.includes('/') && uploadDirName) {
    return toStoredPath(`${uploadDirName}/${basename(key)}`);
  }
  return toStoredPath(key);
}

// Ensure local upload dir exists early (multer may also create it).
try {
  mkdirSync(join(getUploadDir(), uploadDirName), { recursive: true });
} catch {
  // ignore
}

const RequestOtpSchema = z.object({
  phone: z.string().optional(),
  email: z.string().email().optional(),
  channel: z.enum(['sms', 'email', 'whatsapp', 'both']).default('sms'),
}).refine((v) => v.phone || v.email, { message: 'phone or email is required' });

const VerifyOtpSchema = z.object({
  phone: z.string().optional(),
  email: z.string().email().optional(),
  otp: z.string().min(4).max(8),
  channel: z.enum(['sms', 'email', 'whatsapp', 'both']).default('sms'),
}).refine((v) => v.phone || v.email, { message: 'phone or email is required' });

const SignupSchema = z.object({
  phone: z.string().min(10),
  email: z.string().email(),
  password: z.string().min(8),
  state: z.string().min(2),
  city: z.string().min(2),
  pinCode: z.string().min(4).max(10),
  referralCode: z.string().max(64).optional().nullable(),
  fullName: z.string().min(2).optional().nullable(),
  consentToken: z.string().min(16),
  otpId: z.string().min(8),
  channel: z.enum(['sms', 'email', 'whatsapp', 'both']).optional(),
  emailConsentToken: z.string().min(16).optional().nullable(),
  emailOtpId: z.string().min(8).optional().nullable(),
});

const LoginSchema = z.object({
  email: z.string().optional(),
  phone: z.string().optional(),
  emailOrPhone: z.string().optional(),
  password: z.string().min(1),
}).refine((v) => v.email || v.phone || v.emailOrPhone, {
  message: 'email or phone is required',
});

/* ---------- Public: OTP + signup + login ---------- */

agentOnboardingRouter.post('/signup/request-otp', async (req, res, next) => {
  try {
    await ensureAgentOnboardingSchema();
    const input = RequestOtpSchema.parse(req.body || {});
    const phone = input.phone ? normalizePhone(input.phone) : null;
    const email = input.email ? normalizeEmail(input.email) : null;
    const channel = input.channel || 'sms';

    if (phone && !/^[6-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });
    }
    if ((channel === 'sms' || channel === 'whatsapp') && !phone) {
      return res.status(400).json({ error: 'Mobile number is required for SMS/WhatsApp OTP' });
    }
    if (channel === 'email' && !email) {
      return res.status(400).json({ error: 'Email is required for email OTP' });
    }

    const settings = await getOtpProviderSettings();
    const whatsappAvailable = isWhatsappOtpAvailable(settings);
    if (channel === 'whatsapp' && !whatsappAvailable) {
      return res.status(400).json({ error: 'WhatsApp OTP is not available right now. Please use SMS.' });
    }

    const otp = generateOtp();
    const id = newId();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const pool = getPool();

    await pool.execute(
      `INSERT INTO lead_otps (id, lead_id, email, phone, otp_hash, purpose, channel, expires_at)
       VALUES (:id, NULL, :email, :phone, :hash, :purpose, :channel, :exp)`,
      {
        id,
        email,
        phone,
        hash: hashOtp(otp),
        purpose: OTP_PURPOSE,
        channel,
        exp: expiresAt.toISOString(),
      },
    );

    let delivery;
    try {
      delivery = await sendOtpNotification({
        phone,
        email,
        otp,
        channel,
        settings,
        rateLimit: true,
      });
    } catch (otpErr) {
      console.warn('[agent-onboarding-otp]', otpErr?.message || otpErr);
      await pool.execute(`DELETE FROM lead_otps WHERE id = :id`, { id }).catch(() => {});
      // Provider auth failures (e.g. MSG91 401) must not look like an expired user session.
      return sendPublicOtpFailure(res, otpErr);
    }

    // Only the newest code for this mobile/email stays valid.
    await pool.execute(
      `UPDATE lead_otps SET expires_at = NOW()
       WHERE purpose = :purpose AND verified_at IS NULL AND id <> :id
         AND ${phone ? 'phone = :target' : 'email = :target'}`,
      { purpose: OTP_PURPOSE, id, target: phone || email },
    ).catch(() => {});

    res.json({
      success: true,
      otpId: id,
      expiresInSeconds: 600,
      channels: delivery?.channels?.length ? delivery.channels : [channel],
      whatsappAvailable,
      resendAfterSeconds: otpSecurityLimits().resendCooldownSeconds,
      ...(canExposeDevOtp() ? { devOtp: otp } : {}),
    });
  } catch (err) {
    if (err?.name === 'ZodError') {
      const e = new Error(err.issues?.[0]?.message || 'Invalid request');
      e.status = 400;
      return next(e);
    }
    next(err);
  }
});

agentOnboardingRouter.post('/signup/verify-otp', async (req, res, next) => {
  try {
    await ensureAgentOnboardingSchema();
    const input = VerifyOtpSchema.parse(req.body || {});
    const phone = input.phone ? normalizePhone(input.phone) : null;
    const email = input.email ? normalizeEmail(input.email) : null;
    const channel = input.channel || (phone ? 'sms' : 'email');
    const code = String(input.otp || '').trim();
    const allowDevBypass = canExposeDevOtp() && code === '123456';
    const pool = getPool();
    const attemptKeys = otpTargetKeys({ phone, email }).map((k) => `agent_signup:${k}`);
    assertOtpVerifyAllowed(attemptKeys);

    const targetConds = [];
    const params = { purpose: OTP_PURPOSE };
    if (phone) {
      targetConds.push('phone = :phone');
      params.phone = phone;
    }
    if (email) {
      targetConds.push('email = :email');
      params.email = email;
    }
    if (!targetConds.length) {
      return res.status(400).json({ error: 'phone or email is required' });
    }
    if (!allowDevBypass) params.hash = hashOtp(code);

    const [[otpRow]] = await pool.execute(
      `SELECT id, phone, email FROM lead_otps
       WHERE purpose = :purpose
         ${allowDevBypass ? '' : 'AND otp_hash = :hash'}
         AND verified_at IS NULL AND expires_at > NOW()
         AND (${targetConds.join(' OR ')})
       ORDER BY created_at DESC LIMIT 1`,
      params,
    );

    if (!otpRow) {
      throw invalidOtpError(attemptKeys);
    }
    clearOtpVerifyFailures(attemptKeys);

    await pool.execute(
      `UPDATE lead_otps SET verified_at = NOW(), purpose = :purpose WHERE id = :id`,
      { id: otpRow.id, purpose: OTP_PURPOSE_OK },
    );

    const target = channel === 'email'
      ? normalizeEmail(email || otpRow.email)
      : normalizePhone(phone || otpRow.phone);
    const consentChannel = channel === 'email' ? 'email' : 'sms';
    const consentToken = buildConsentToken({
      target,
      otpId: otpRow.id,
      channel: consentChannel,
    });

    res.json({
      verified: true,
      consentToken,
      otpId: otpRow.id,
      channel: consentChannel,
      expiresInSeconds: Math.floor(TOKEN_TTL_MS / 1000),
    });
  } catch (err) {
    if (err?.name === 'ZodError') {
      const e = new Error(err.issues?.[0]?.message || 'Invalid request');
      e.status = 400;
      return next(e);
    }
    next(err);
  }
});

agentOnboardingRouter.post('/signup', async (req, res, next) => {
  try {
    await ensureAgentOnboardingSchema();
    const body = req.body || {};
    const input = SignupSchema.parse({
      phone: body.phone,
      email: body.email,
      password: body.password,
      state: body.state,
      city: body.city,
      pinCode: body.pinCode || body.pin_code,
      referralCode: body.referralCode || body.referral_code || null,
      fullName: body.fullName || body.full_name || null,
      consentToken: body.consentToken || body.consent_token,
      otpId: body.otpId || body.otp_id,
      channel: body.channel,
      emailConsentToken: body.emailConsentToken || body.email_consent_token || null,
      emailOtpId: body.emailOtpId || body.email_otp_id || null,
    });

    const phone = normalizePhone(input.phone);
    const email = normalizeEmail(input.email);
    const channel = input.channel === 'email' ? 'email' : 'sms';

    await assertSignupConsent({
      phone,
      email,
      consentToken: input.consentToken,
      otpId: input.otpId,
      channel,
    });

    let emailOtpId = channel === 'email' ? input.otpId : null;
    if (input.emailConsentToken && input.emailOtpId) {
      await assertSignupConsent({
        phone,
        email,
        consentToken: input.emailConsentToken,
        otpId: input.emailOtpId,
        channel: 'email',
      });
      emailOtpId = input.emailOtpId;
    }

    const application = await createDraftApplication({
      phoneOtpId: channel === 'sms' ? input.otpId : null,
      emailOtpId,
      email,
      phone,
      password: input.password,
      state: input.state,
      city: input.city,
      pinCode: input.pinCode,
      referralCode: input.referralCode,
      fullName: input.fullName,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });

    const accessJwt = issueApplicantAccessToken(application);
    res.status(201).json({
      success: true,
      accessToken: accessJwt,
      accessJwt,
      application,
    });
  } catch (err) {
    if (err?.name === 'ZodError') {
      const e = new Error(err.issues?.[0]?.message || 'Invalid signup data');
      e.status = 400;
      return next(e);
    }
    next(err);
  }
});

agentOnboardingRouter.post('/login', async (req, res, next) => {
  try {
    await ensureAgentOnboardingSchema();
    const input = LoginSchema.parse(req.body || {});
    const emailOrPhone =
      input.emailOrPhone
      || input.email
      || input.phone;
    const { accessJwt, application } = await applicantLogin(emailOrPhone, input.password);
    res.json({
      success: true,
      accessToken: accessJwt,
      accessJwt,
      application,
    });
  } catch (err) {
    if (err?.name === 'ZodError') {
      const e = new Error(err.issues?.[0]?.message || 'Invalid login data');
      e.status = 400;
      return next(e);
    }
    next(err);
  }
});

/* ---------- Admin checklist (before /:id) ---------- */

agentOnboardingRouter.get(
  '/checklist-templates',
  authenticate,
  requireCanManage,
  async (req, res, next) => {
    try {
      const entityType = req.query.entityType || req.query.entity_type || '';
      const templates = await listChecklistForEntity(entityType);
      res.json({ templates });
    } catch (err) {
      next(err);
    }
  },
);

agentOnboardingRouter.put(
  '/checklist-templates',
  authenticate,
  requireCanManage,
  async (req, res, next) => {
    try {
      const templates = Array.isArray(req.body?.templates) ? req.body.templates : req.body;
      const saved = await replaceChecklistTemplates(templates);
      res.json({ templates: saved });
    } catch (err) {
      next(err);
    }
  },
);

/* ---------- Applicant (authenticated) ---------- */

agentOnboardingRouter.get('/me', authenticateApplicant, async (req, res, next) => {
  try {
    const application = await loadApplicationBundle(req.auth.applicationId);
    res.json({ application });
  } catch (err) {
    next(err);
  }
});

agentOnboardingRouter.patch('/me/entity', authenticateApplicant, async (req, res, next) => {
  try {
    const body = req.body || {};
    const entityPayload = Object.prototype.hasOwnProperty.call(body, 'entityPayload')
      ? body.entityPayload
      : (Object.prototype.hasOwnProperty.call(body, 'entity_payload') ? body.entity_payload : undefined);
    const application = await updateEntity(req.auth.applicationId, {
      entityType: body.entityType || body.entity_type,
      entityPayload,
      fullName: body.fullName || body.full_name,
    });
    res.json({ application });
  } catch (err) {
    next(err);
  }
});

agentOnboardingRouter.put('/me/parties', authenticateApplicant, async (req, res, next) => {
  try {
    const parties = Array.isArray(req.body?.parties) ? req.body.parties : req.body;
    const application = await upsertParties(req.auth.applicationId, parties);
    res.json({ application });
  } catch (err) {
    next(err);
  }
});

agentOnboardingRouter.put('/me/bank', authenticateApplicant, async (req, res, next) => {
  try {
    const { application, verification } = await saveBank(req.auth.applicationId, req.body || {});
    res.json({ application, verification });
  } catch (err) {
    next(err);
  }
});

agentOnboardingRouter.post(
  '/me/documents/:documentType',
  authenticateApplicant,
  ...spreadUpload(upload, 'single', 'file'),
  async (req, res, next) => {
    try {
      const documentType = String(req.params.documentType || '').trim().toLowerCase();
      const path = storedPath(req.file);
      if (!path) {
        const e = new Error('file is required');
        e.status = 400;
        throw e;
      }
      const meta = {
        documentNumber: req.body?.documentNumber || req.body?.document_number,
        issueDate: req.body?.issueDate || req.body?.issue_date,
        expiryDate: req.body?.expiryDate || req.body?.expiry_date,
      };
      const document = await setDocumentFile(req.auth.applicationId, documentType, path, meta);
      res.status(201).json({ document });
    } catch (err) {
      next(err);
    }
  },
);

agentOnboardingRouter.patch('/me/documents/:id', authenticateApplicant, async (req, res, next) => {
  try {
    const document = await patchDocumentById(req.auth.applicationId, req.params.id, req.body || {});
    res.json({ document });
  } catch (err) {
    next(err);
  }
});

agentOnboardingRouter.post('/me/agreements', authenticateApplicant, async (req, res, next) => {
  try {
    const application = await acceptAgreements(req.auth.applicationId, {
      agreements: req.body?.agreements || req.body || {},
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });
    res.json({ application });
  } catch (err) {
    next(err);
  }
});

agentOnboardingRouter.post('/me/submit', authenticateApplicant, async (req, res, next) => {
  try {
    const application = await submitApplication(req.auth.applicationId, {
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });
    res.json({ application });
  } catch (err) {
    next(err);
  }
});

agentOnboardingRouter.get('/me/actions', authenticateApplicant, async (req, res, next) => {
  try {
    const actions = await listApplicationActions(req.auth.applicationId);
    res.json({ actions });
  } catch (err) {
    next(err);
  }
});

/* ---------- Admin / employee review ---------- */

agentOnboardingRouter.get('/', authenticate, requireCanReview, async (req, res, next) => {
  try {
    const isAdmin = canManage(req.auth.role);
    const applications = await adminListApplications({
      status: req.query.status || null,
      entityType: req.query.entityType || req.query.entity_type || null,
      q: req.query.q || req.query.search || null,
      assignedEmployeeId: isAdmin
        ? (req.query.assignedEmployeeId || req.query.assigned_employee_id || null)
        : req.auth.userId,
      unassignedOnly: isAdmin && String(req.query.unassigned || '') === '1',
      limit: req.query.limit,
      offset: req.query.offset,
    });
    // Employees only see non-draft applications assigned to them (filter already applied).
    res.json({
      applications: isAdmin
        ? applications
        : applications.filter((a) => a.workflowStatus !== 'draft'),
      viewerRole: isAdmin ? 'admin' : 'employee',
    });
  } catch (err) {
    next(err);
  }
});

agentOnboardingRouter.get('/:id', authenticate, requireCanReview, async (req, res, next) => {
  try {
    const application = await adminGetApplication(req.params.id);
    await assertEmployeeCanAccessApplication(req, application);
    res.json({
      application,
      viewerRole: canManage(req.auth.role) ? 'admin' : 'employee',
      allowedActions: canManage(req.auth.role)
        ? null
        : [...EMPLOYEE_REVIEW_ACTIONS],
    });
  } catch (err) {
    next(err);
  }
});

agentOnboardingRouter.get(
  '/:id/documents/:documentId/file',
  authenticate,
  requireCanReview,
  async (req, res, next) => {
    try {
      const application = await adminGetApplication(req.params.id);
      await assertEmployeeCanAccessApplication(req, application);
      const doc = (application.documents || []).find(
        (d) => String(d.id) === String(req.params.documentId),
      );
      if (!doc?.filePath && !doc?.fileUrl) {
        return res.status(404).json({ error: 'Document file not found' });
      }

      const stored = doc.filePath || String(doc.fileUrl || '').replace(/^\/uploads\//, '');
      const opened = await streamStoredUpload(stored).catch(() => null);
      if (opened?.stream) {
        res.setHeader('Content-Type', opened.contentType || 'application/octet-stream');
        res.setHeader(
          'Content-Disposition',
          `inline; filename="${basename(String(stored))}"`,
        );
        return opened.stream.pipe(res);
      }

      const localName = basename(String(stored));
      const fullPath = resolve(getUploadDir(), 'agent-onboarding', localName);
      const altPath = resolve(getUploadDir(), String(stored).replace(/^\/+/, ''));
      const path = existsSync(fullPath) ? fullPath : existsSync(altPath) ? altPath : null;
      if (!path) return res.status(404).json({ error: 'Document file missing on server' });
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${localName}"`);
      res.send(readFileSync(path));
    } catch (err) {
      next(err);
    }
  },
);

agentOnboardingRouter.post('/:id/action', authenticate, requireCanReview, async (req, res, next) => {
  try {
    const body = req.body || {};
    const isAdmin = canManage(req.auth.role);
    if (!isAdmin) {
      const application = await adminGetApplication(req.params.id);
      await assertEmployeeCanAccessApplication(req, application);
      await assertEmployeeAccess(req, 'agents', 'write');
    }

    const result = await adminTransition(req.params.id, {
      action: body.action,
      remarks: body.remarks || null,
      documentId: body.documentId || body.document_id || null,
      field: body.field || null,
      result: body.result || null,
      assigneeUserId: body.assigneeUserId || body.assignedEmployeeId || body.assigned_employee_id || null,
      actorUserId: req.auth.userId,
      actorLabel: req.auth.role,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
      allowAdminOnlyActions: isAdmin,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});
