import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

import { getPool, isDuplicateEntryError } from '../db/pool.js';
import { ensureAgentOnboardingSchema } from '../db/ensureAgentOnboardingSchema.js';
import { ensureOnboardingSchema } from '../db/ensureOnboardingSchema.js';
import { newId } from './ids.js';
import { allocateApplicationId } from './agentApplicationId.js';
import { verifyBankAccount } from './bankVerification.js';
import { createAgentAccount } from './staffOnboarding.js';
import {
  getIndianFinancialYearLabel,
  reserveUniqueAgentCodeForFy,
} from './agentCode.js';
import {
  sendEmail,
  sendPartnerApplicationAdminEmail,
  sendPartnerRejectionEmail,
  sendPartnerWelcomeEmail,
} from './email.js';
import { getSuperAdminRecipientEmails } from './partnerRegistration.js';
import { writeAuditLog } from './audit.js';
import { signAccessToken } from './jwt.js';
import { sqlParamEquals } from './sqlCollation.js';

const ENTITY_TYPES = new Set(['individual', 'proprietorship', 'partnership', 'private_limited']);
const PARTY_ROLES = new Set(['partner', 'director', 'authorised_signatory', 'proprietor']);

const EDITABLE_STATUSES = new Set(['draft', 'sent_back', 'reupload_required']);

function httpError(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

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

function docUrl(path) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const base = process.env.API_PUBLIC_URL || process.env.APP_PUBLIC_URL || '';
  const uploadBase = base ? `${base.replace(/\/$/, '')}/uploads` : '/uploads';
  const normalized = String(path)
    .replace(/\\/g, '/')
    .replace(/^\/uploads\//i, '')
    .replace(/^uploads\//i, '')
    .replace(/^\/+/, '');
  return `${uploadBase}/${normalized.split('/').map(encodeURIComponent).join('/')}`;
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

export function mapParty(row) {
  if (!row) return null;
  return {
    id: row.id,
    applicationId: row.application_id,
    partyRole: row.party_role,
    fullName: row.full_name,
    dob: row.dob,
    pan: row.pan,
    mobile: row.mobile,
    email: row.email,
    address: row.address,
    din: row.din,
    designation: row.designation,
    ownershipPct: row.ownership_pct != null ? Number(row.ownership_pct) : null,
    isAuthorised: Boolean(row.is_authorised),
    photoUrl: docUrl(row.photo_path),
    signatureUrl: docUrl(row.signature_path),
    kycDocUrl: docUrl(row.kyc_doc_path),
    sortOrder: Number(row.sort_order || 0),
    meta: parseJson(row.meta_json, null),
  };
}

export function mapDocument(row) {
  if (!row) return null;
  return {
    id: row.id,
    applicationId: row.application_id,
    documentType: row.document_type,
    isMandatory: Boolean(row.is_mandatory),
    documentNumber: row.document_number,
    issueDate: row.issue_date,
    expiryDate: row.expiry_date,
    fileUrl: docUrl(row.file_path),
    filePath: row.file_path || null,
    status: row.status,
    rejectionReason: row.rejection_reason,
    uploadedAt: row.uploaded_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
  };
}

export function mapAction(row) {
  if (!row) return null;
  return {
    id: row.id,
    applicationId: row.application_id,
    actorUserId: row.actor_user_id,
    actorLabel: row.actor_label,
    action: row.action,
    remarks: row.remarks,
    ip: row.ip,
    userAgent: row.user_agent,
    createdAt: row.created_at,
  };
}

export function mapChecklistTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    entityType: row.entity_type,
    documentType: row.document_type,
    label: row.label,
    isMandatory: Boolean(row.is_mandatory),
    maxSizeMb: Number(row.max_size_mb || 10),
    sortOrder: Number(row.sort_order || 0),
    isActive: Boolean(row.is_active),
  };
}

export function computeApplicationRisk(app) {
  let score = 0;
  const reasons = [];
  const entity = String(app?.entityType || '').toLowerCase();
  if (entity === 'partnership' || entity === 'private_limited') {
    score += 1;
    reasons.push('complex_entity');
  }
  const bankStatus = String(app?.bank?.verifyStatus || '').toLowerCase();
  if (!app?.bank?.accountNumber) {
    score += 2;
    reasons.push('bank_missing');
  } else if (bankStatus && !['verified', 'manual_verified'].includes(bankStatus)) {
    score += 1;
    reasons.push('bank_unverified');
  }
  const docs = Array.isArray(app?.documents) ? app.documents : [];
  const rejected = docs.filter((d) => d.status === 'rejected' || d.status === 'reupload_required').length;
  if (rejected) {
    score += Math.min(2, rejected);
    reasons.push('docs_rejected');
  }
  const summary = app?.documentSummary;
  if (summary?.mandatoryMissing > 0) {
    score += 2;
    reasons.push('mandatory_docs_missing');
  }
  if (!app?.entityPayload?.pan && !app?.entityPayload?.panNumber) {
    score += 1;
    reasons.push('pan_missing');
  }
  let level = 'Low';
  if (score >= 4) level = 'High';
  else if (score >= 2) level = 'Medium';
  return { level, score, reasons };
}

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** Required applicant fields per entity type (mirrors the /become-partner wizard). */
export const ENTITY_FIELD_DEFS = {
  individual: [
    { key: 'pan', label: 'PAN', required: true, verify: true },
    { key: 'aadhaar', label: 'Aadhaar (masked)', required: false, verify: true },
    { key: 'dob', label: 'Date of birth', required: false, verify: true },
    { key: 'address', label: 'Address', required: true, verify: true },
  ],
  proprietorship: [
    { key: 'firmName', label: 'Firm name', required: true, verify: true },
    { key: 'tradeName', label: 'Trade name', required: false, verify: false },
    { key: 'proprietorName', label: 'Proprietor name', required: true, verify: true },
    { key: 'pan', label: 'PAN', required: true, verify: true },
    { key: 'gstin', label: 'GSTIN', required: false, verify: true },
    { key: 'businessAddress', label: 'Business address', required: false, verify: true },
  ],
  partnership: [
    { key: 'firmName', label: 'Firm name', required: true, verify: true },
    { key: 'pan', label: 'Firm PAN', required: true, verify: true },
    { key: 'gstin', label: 'GSTIN', required: false, verify: true },
    { key: 'registeredAddress', label: 'Registered address', required: false, verify: true },
  ],
  private_limited: [
    { key: 'companyName', label: 'Company name', required: true, verify: true },
    { key: 'cin', label: 'CIN', required: false, verify: true },
    { key: 'pan', label: 'Company PAN', required: true, verify: true },
    { key: 'gstin', label: 'GSTIN', required: false, verify: true },
    { key: 'registeredAddress', label: 'Registered office address', required: false, verify: true },
  ],
};

const AGREEMENT_KEYS = ['termsOfService', 'privacyPolicy', 'codeOfConduct', 'fairPractices', 'kycAml'];

function isBankVerified(status) {
  return ['verified', 'manual_verified'].includes(String(status || '').toLowerCase());
}

/**
 * Admin verification summary: per-section completeness, checklist vs uploads,
 * and the blockers that prevent approval / activation.
 */
export function buildReviewSummary(app, checklist = []) {
  const entityType = String(app?.entityType || '').toLowerCase();
  const payload = app?.entityPayload || {};
  const checks = app?.fieldChecks || {};
  const docs = Array.isArray(app?.documents) ? app.documents : [];
  const parties = Array.isArray(app?.parties) ? app.parties : [];
  const blockers = [];

  const signup = {
    phoneVerified: Boolean(app?.phoneVerifiedAt),
    phoneVerifiedAt: app?.phoneVerifiedAt || null,
    emailVerified: Boolean(app?.emailVerifiedAt),
    emailVerifiedAt: app?.emailVerifiedAt || null,
    signupIp: app?.signupIp || null,
  };
  // Pre-migration applications have no OTP evidence columns; the signup API always required mobile OTP.
  const legacySignup = !app?.phoneVerifiedAt && !app?.emailVerifiedAt;
  if (!legacySignup && !signup.phoneVerified) blockers.push('Mobile number not OTP-verified');

  const fieldDefs = ENTITY_FIELD_DEFS[entityType] || [];
  const fields = fieldDefs.map((def) => {
    const raw = payload?.[def.key];
    const value = raw == null ? '' : String(raw).trim();
    let formatOk = true;
    if (def.key === 'pan' && value) formatOk = PAN_RE.test(value.toUpperCase());
    const check = checks[`entity.${def.key}`] || null;
    const digits = value.replace(/\D/g, '');
    const display = def.key === 'aadhaar' && digits.length >= 4
      ? `XXXX XXXX ${digits.slice(-4)}`
      : value;
    return {
      key: `entity.${def.key}`,
      field: def.key,
      label: def.label,
      value: display || null,
      required: def.required,
      verifiable: def.verify,
      present: Boolean(value),
      formatOk,
      check,
    };
  });
  if (!entityType) blockers.push('Entity type not selected');
  fields.forEach((f) => {
    if (f.required && !f.present) blockers.push(`${f.label} missing`);
    else if (f.present && !f.formatOk) blockers.push(`${f.label} format invalid`);
    if (f.check?.result === 'mismatch') blockers.push(`${f.label} marked as mismatch`);
  });
  const panField = fields.find((f) => f.field === 'pan');
  if (panField?.present && panField.check?.result !== 'verified') {
    blockers.push(`${panField.label} not verified against document`);
  }

  const partyRows = parties.map((p) => {
    const check = checks[`party.${p.id}`] || null;
    if (check?.result === 'mismatch') blockers.push(`${p.fullName || 'Party'} KYC marked as mismatch`);
    return { ...p, check };
  });
  let partiesRequirement = null;
  if (entityType === 'partnership') {
    partiesRequirement = 'At least 2 partners, one authorised';
    if (parties.length < 2) blockers.push('At least two partners required');
  }
  if (entityType === 'private_limited') {
    partiesRequirement = 'At least 1 director, one authorised';
    if (parties.length < 1) blockers.push('At least one director required');
  }
  if (partiesRequirement && parties.length && !parties.some((p) => p.isAuthorised)) {
    blockers.push('No authorised signatory marked');
  }

  const byType = new Map();
  docs.forEach((d) => {
    const key = String(d.documentType || '').toLowerCase();
    if (!byType.has(key)) byType.set(key, d);
  });
  const checklistRows = (checklist || []).map((tpl) => {
    const doc = byType.get(String(tpl.documentType || '').toLowerCase()) || null;
    const hasFile = Boolean(doc?.fileUrl || doc?.filePath);
    const status = !doc || !hasFile ? 'missing' : String(doc.status || 'uploaded');
    return {
      documentType: tpl.documentType,
      label: tpl.label,
      isMandatory: Boolean(tpl.isMandatory),
      maxSizeMb: tpl.maxSizeMb,
      status,
      document: doc,
    };
  });
  const templateTypes = new Set(checklistRows.map((r) => String(r.documentType).toLowerCase()));
  docs
    .filter((d) => !templateTypes.has(String(d.documentType || '').toLowerCase()))
    .forEach((d) => {
      checklistRows.push({
        documentType: d.documentType,
        label: String(d.documentType || 'Document').replace(/_/g, ' '),
        isMandatory: false,
        maxSizeMb: null,
        status: d.fileUrl || d.filePath ? String(d.status || 'uploaded') : 'missing',
        document: d,
      });
    });

  const mandatoryRows = checklistRows.filter((r) => r.isMandatory);
  const documentsSummary = {
    mandatoryTotal: mandatoryRows.length,
    mandatoryMissing: mandatoryRows.filter((r) => r.status === 'missing').length,
    mandatoryVerified: mandatoryRows.filter((r) => r.status === 'verified').length,
    pendingReview: checklistRows.filter((r) => ['uploaded', 'pending', 'pending_review'].includes(r.status)).length,
    rejected: checklistRows.filter((r) => ['rejected', 'reupload_required'].includes(r.status)).length,
    uploaded: checklistRows.filter((r) => r.status !== 'missing').length,
  };
  mandatoryRows.forEach((r) => {
    if (r.status === 'missing') blockers.push(`${r.label} not uploaded`);
    else if (r.status === 'rejected' || r.status === 'reupload_required') blockers.push(`${r.label} rejected — awaiting re-upload`);
    else if (r.status !== 'verified') blockers.push(`${r.label} not verified`);
  });

  const bank = app?.bank || {};
  const bankSection = {
    present: Boolean(bank.accountNumber && bank.ifsc),
    verified: isBankVerified(bank.verifyStatus),
    verifyStatus: bank.verifyStatus || null,
    verifiedAt: bank.verifiedAt || null,
    ifscFormatOk: bank.ifsc ? /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(bank.ifsc).toUpperCase()) : false,
    holderMatchesName: (() => {
      const holder = String(bank.holderName || '').trim().toLowerCase();
      const names = [app?.fullName, payload.proprietorName, payload.firmName, payload.companyName]
        .filter(Boolean)
        .map((n) => String(n).trim().toLowerCase());
      if (!holder || !names.length) return null;
      return names.some((n) => n === holder || n.includes(holder) || holder.includes(n));
    })(),
  };
  if (!bankSection.present) blockers.push('Bank details missing');
  else if (!bankSection.verified) blockers.push('Bank account not verified');

  const agreements = app?.agreements || {};
  const agreementsSection = {
    acceptedAt: app?.agreementsAcceptedAt || null,
    ip: app?.agreementsIp || null,
    userAgent: app?.agreementsUserAgent || null,
    items: AGREEMENT_KEYS.map((key) => ({ key, accepted: Boolean(agreements?.[key]) })),
  };
  agreementsSection.allAccepted = Boolean(agreementsSection.acceptedAt)
    && agreementsSection.items.every((i) => i.accepted);
  if (!agreementsSection.allAccepted) blockers.push('Agreements not fully accepted');

  if (!app?.submittedAt) blockers.push('Application not submitted by applicant');

  return {
    signup,
    entity: { entityType: entityType || null, fields },
    parties: { requirement: partiesRequirement, rows: partyRows },
    checklist: checklistRows,
    documents: documentsSummary,
    bank: bankSection,
    agreements: agreementsSection,
    blockers: [...new Set(blockers)],
    readyForApproval: blockers.length === 0,
  };
}

export function mapApplication(row, { parties = [], documents = [], actions = [], documentSummary = null } = {}) {
  if (!row) return null;
  const mapped = {
    id: row.id,
    applicationId: row.application_id,
    entityType: row.entity_type,
    workflowStatus: row.workflow_status,
    email: row.email,
    phone: row.phone,
    fullName: row.full_name,
    state: row.state,
    city: row.city,
    pinCode: row.pin_code,
    referralCode: row.referral_code,
    entityPayload: parseJson(row.entity_payload, {}),
    bank: {
      holderName: row.bank_holder_name,
      bankName: row.bank_name,
      accountNumber: row.bank_account_number,
      ifsc: row.bank_ifsc,
      accountType: row.bank_account_type,
      verifyStatus: row.bank_verify_status,
      verifiedAt: row.bank_verified_at || null,
      verifiedBy: row.bank_verified_by || null,
    },
    phoneVerifiedAt: row.phone_verified_at || null,
    emailVerifiedAt: row.email_verified_at || null,
    signupIp: row.signup_ip || null,
    signupUserAgent: row.signup_user_agent || null,
    fieldChecks: parseJson(row.field_checks_json, {}) || {},
    agreements: parseJson(row.agreements_json, null),
    agreementsAcceptedAt: row.agreements_accepted_at,
    agreementsIp: row.agreements_ip || null,
    agreementsUserAgent: row.agreements_user_agent || null,
    submittedAt: row.submitted_at,
    activatedUserId: row.activated_user_id,
    assignedAgentCode: row.assigned_agent_code,
    rejectionReason: row.rejection_reason,
    legacyPartnerRegistrationId: row.legacy_partner_registration_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    parties: parties.map(mapParty),
    documents: documents.map(mapDocument),
    actions: actions.map(mapAction),
    documentSummary: documentSummary || null,
  };
  mapped.risk = computeApplicationRisk(mapped);
  mapped.kycStatus = mapped.entityPayload?.pan || mapped.entityPayload?.panNumber
    ? (mapped.workflowStatus === 'kyc_verification' ? 'Pending' : 'Complete')
    : (mapped.entityType ? 'Partial' : '—');
  return mapped;
}

export async function ensureSchema() {
  await ensureAgentOnboardingSchema();
}

export async function recordAction({
  applicationId,
  actorUserId = null,
  actorLabel = null,
  action,
  remarks = null,
  ip = null,
  userAgent = null,
}) {
  await ensureSchema();
  const pool = getPool();
  const id = newId();
  await pool.execute(
    `INSERT INTO agent_application_actions (
       id, application_id, actor_user_id, actor_label, action, remarks, ip, user_agent
     ) VALUES (
       :id, :application_id, :actor_user_id, :actor_label, :action, :remarks, :ip, :user_agent
     )`,
    {
      id,
      application_id: applicationId,
      actor_user_id: actorUserId,
      actor_label: actorLabel,
      action,
      remarks,
      ip,
      user_agent: userAgent ? String(userAgent).slice(0, 512) : null,
    },
  );
  return id;
}

async function getApplicationRow(pool, idOrPublicId) {
  const [[row]] = await pool.execute(
    `SELECT * FROM agent_applications
     WHERE id = :id OR application_id = :id
     LIMIT 1`,
    { id: idOrPublicId },
  );
  return row || null;
}

export async function loadApplicationBundle(idOrPublicId) {
  await ensureSchema();
  const pool = getPool();
  const row = await getApplicationRow(pool, idOrPublicId);
  if (!row) return null;
  const [parties] = await pool.execute(
    `SELECT * FROM agent_application_parties
     WHERE application_id = :id ORDER BY sort_order ASC, created_at ASC`,
    { id: row.id },
  );
  const [documents] = await pool.execute(
    `SELECT * FROM agent_application_documents
     WHERE application_id = :id ORDER BY created_at ASC`,
    { id: row.id },
  );
  const [actions] = await pool.execute(
    `SELECT * FROM agent_application_actions
     WHERE application_id = :id ORDER BY created_at DESC LIMIT 100`,
    { id: row.id },
  );
  return mapApplication(row, { parties, documents, actions });
}

export async function createDraftApplication({
  email,
  phone,
  password,
  state,
  city,
  pinCode,
  referralCode = null,
  fullName = null,
  ip = null,
  userAgent = null,
  phoneOtpId = null,
  emailOtpId = null,
}) {
  await ensureSchema();
  const pool = getPool();
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);

  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw httpError('Valid email is required');
  }
  if (!/^[6-9]\d{9}$/.test(normalizedPhone)) {
    throw httpError('Valid 10-digit mobile number is required');
  }
  if (!password || String(password).length < 8) {
    throw httpError('Password must be at least 8 characters');
  }

  const [[dup]] = await pool.execute(
    `SELECT id, workflow_status FROM agent_applications
     WHERE email = :email OR phone = :phone
     ORDER BY created_at DESC LIMIT 1`,
    { email: normalizedEmail, phone: normalizedPhone },
  );
  if (dup && !['rejected', 'suspended'].includes(String(dup.workflow_status || ''))) {
    throw httpError('An application already exists for this email or phone', 409);
  }

  const id = newId();
  const applicationId = await allocateApplicationId(pool);
  const passwordHash = await bcrypt.hash(String(password), 12);

  try {
    await pool.execute(
      `INSERT INTO agent_applications (
         id, application_id, workflow_status, email, phone, password_hash,
         full_name, state, city, pin_code, referral_code,
         phone_otp_id, phone_verified_at, email_otp_id, email_verified_at,
         signup_ip, signup_user_agent
       ) VALUES (
         :id, :application_id, 'draft', :email, :phone, :password_hash,
         :full_name, :state, :city, :pin_code, :referral_code,
         :phone_otp_id, ${phoneOtpId ? 'NOW()' : 'NULL'},
         :email_otp_id, ${emailOtpId ? 'NOW()' : 'NULL'},
         :signup_ip, :signup_user_agent
       )`,
      {
        id,
        application_id: applicationId,
        email: normalizedEmail,
        phone: normalizedPhone,
        password_hash: passwordHash,
        full_name: fullName ? String(fullName).trim() : null,
        state: state ? String(state).trim() : null,
        city: city ? String(city).trim() : null,
        pin_code: pinCode ? String(pinCode).trim() : null,
        referral_code: referralCode ? String(referralCode).trim() : null,
        phone_otp_id: phoneOtpId || null,
        email_otp_id: emailOtpId || null,
        signup_ip: ip ? String(ip).slice(0, 64) : null,
        signup_user_agent: userAgent ? String(userAgent).slice(0, 512) : null,
      },
    );
  } catch (err) {
    if (isDuplicateEntryError(err)) {
      throw httpError('An application already exists for this email or phone', 409);
    }
    throw err;
  }

  await recordAction({
    applicationId: id,
    actorLabel: 'applicant',
    action: 'signup',
    remarks: [
      'Draft application created',
      phoneOtpId ? 'mobile OTP verified' : 'mobile OTP not verified',
      emailOtpId ? 'email OTP verified' : 'email OTP not verified',
    ].join('; '),
    ip,
    userAgent,
  });

  return loadApplicationBundle(id);
}

export function issueApplicantAccessToken(application) {
  return signAccessToken({
    userId: application.id,
    role: 'agent_applicant',
    email: application.email,
    applicationId: application.id,
  });
}

export async function applicantLogin(emailOrPhone, password) {
  await ensureSchema();
  const pool = getPool();
  const raw = String(emailOrPhone || '').trim();
  const asEmail = normalizeEmail(raw);
  const asPhone = normalizePhone(raw);

  const [[row]] = await pool.execute(
    `SELECT * FROM agent_applications
     WHERE email = :email OR phone = :phone
     ORDER BY created_at DESC LIMIT 1`,
    { email: asEmail, phone: asPhone },
  );
  if (!row) throw httpError('Invalid credentials', 401);

  const ok = await bcrypt.compare(String(password || ''), row.password_hash);
  if (!ok) throw httpError('Invalid credentials', 401);

  if (['suspended', 'rejected'].includes(String(row.workflow_status || ''))) {
    throw httpError(`Application is ${row.workflow_status}`, 403);
  }

  const application = await loadApplicationBundle(row.id);
  const accessJwt = issueApplicantAccessToken(application);
  return { accessJwt, application };
}

function assertEditable(row) {
  if (!EDITABLE_STATUSES.has(String(row.workflow_status || ''))) {
    throw httpError(`Application cannot be edited in status '${row.workflow_status}'`);
  }
}

export async function updateEntity(applicationId, { entityType, entityPayload, fullName }) {
  await ensureSchema();
  const pool = getPool();
  const row = await getApplicationRow(pool, applicationId);
  if (!row) throw httpError('Application not found', 404);
  assertEditable(row);

  const nextType = entityType != null ? String(entityType).trim().toLowerCase() : row.entity_type;
  if (nextType && !ENTITY_TYPES.has(nextType)) {
    throw httpError('Invalid entity_type');
  }

  const payload =
    entityPayload !== undefined && entityPayload !== null
      ? (typeof entityPayload === 'string' ? entityPayload : JSON.stringify(entityPayload || {}))
      : null;

  await pool.execute(
    `UPDATE agent_applications SET
       entity_type = COALESCE(CAST(:entity_type AS VARCHAR(32)), entity_type),
       entity_payload = COALESCE(CAST(:entity_payload AS JSONB), entity_payload),
       full_name = COALESCE(CAST(:full_name AS VARCHAR(255)), full_name),
       updated_at = NOW()
     WHERE id = :id`,
    {
      id: row.id,
      entity_type: nextType || null,
      entity_payload: payload,
      full_name: fullName != null ? String(fullName).trim() : null,
    },
  );

  return loadApplicationBundle(row.id);
}

export async function upsertParties(applicationId, parties = []) {
  await ensureSchema();
  const pool = getPool();
  const row = await getApplicationRow(pool, applicationId);
  if (!row) throw httpError('Application not found', 404);
  assertEditable(row);

  if (!Array.isArray(parties)) throw httpError('parties must be an array');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(`DELETE FROM agent_application_parties WHERE application_id = :id`, {
      id: row.id,
    });

    let sort = 0;
    for (const party of parties) {
      const role = String(party.partyRole || party.party_role || '').trim().toLowerCase();
      if (!PARTY_ROLES.has(role)) {
        throw httpError(`Invalid party_role: ${role || '(empty)'}`);
      }
      await conn.execute(
        `INSERT INTO agent_application_parties (
           id, application_id, party_role, full_name, dob, pan, mobile, email, address,
           din, designation, ownership_pct, is_authorised, photo_path, signature_path,
           kyc_doc_path, sort_order, meta_json
         ) VALUES (
           :id, :application_id, :party_role, :full_name, CAST(:dob AS DATE), :pan, :mobile, :email, :address,
           :din, :designation, CAST(:ownership_pct AS NUMERIC), :is_authorised, :photo_path, :signature_path,
           :kyc_doc_path, :sort_order, CAST(:meta_json AS JSONB)
         )`,
        {
          id: party.id || newId(),
          application_id: row.id,
          party_role: role,
          full_name: party.fullName || party.full_name || null,
          dob: party.dob || null,
          pan: party.pan ? String(party.pan).trim().toUpperCase() : null,
          mobile: party.mobile ? normalizePhone(party.mobile) : null,
          email: party.email ? normalizeEmail(party.email) : null,
          address: party.address || null,
          din: party.din || null,
          designation: party.designation || null,
          ownership_pct:
            party.ownershipPct != null || party.ownership_pct != null
              ? Number(party.ownershipPct ?? party.ownership_pct)
              : null,
          is_authorised: Boolean(party.isAuthorised ?? party.is_authorised),
          photo_path: party.photoPath || party.photo_path || null,
          signature_path: party.signaturePath || party.signature_path || null,
          kyc_doc_path: party.kycDocPath || party.kyc_doc_path || null,
          sort_order: party.sortOrder != null ? Number(party.sortOrder) : sort,
          meta_json: party.meta != null ? JSON.stringify(party.meta) : null,
        },
      );
      sort += 1;
    }

    await conn.execute(`UPDATE agent_applications SET updated_at = NOW() WHERE id = :id`, {
      id: row.id,
    });
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return loadApplicationBundle(row.id);
}

export async function saveBank(applicationId, bank = {}) {
  await ensureSchema();
  const pool = getPool();
  const row = await getApplicationRow(pool, applicationId);
  if (!row) throw httpError('Application not found', 404);
  assertEditable(row);

  const holderName = String(bank.holderName || bank.holder_name || '').trim();
  const bankName = String(bank.bankName || bank.bank_name || '').trim();
  const accountNumber = String(bank.accountNumber || bank.account_number || '').trim();
  const ifsc = String(bank.ifsc || bank.ifscCode || bank.ifsc_code || '').trim().toUpperCase();
  const accountType = String(bank.accountType || bank.account_type || '').trim() || null;

  if (!holderName || !bankName || !accountNumber || !ifsc) {
    throw httpError('Bank holder name, bank name, account number, and IFSC are required');
  }
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
    throw httpError('Invalid IFSC format');
  }

  const verification = await verifyBankAccount({
    holderName,
    accountNumber,
    ifsc,
    accountType,
  });

  await pool.execute(
    `UPDATE agent_applications SET
       bank_holder_name = :holder,
       bank_name = :bank_name,
       bank_account_number = :acc,
       bank_ifsc = :ifsc,
       bank_account_type = :account_type,
       bank_verify_status = :verify_status,
       updated_at = NOW()
     WHERE id = :id`,
    {
      id: row.id,
      holder: holderName,
      bank_name: bankName,
      acc: accountNumber,
      ifsc,
      account_type: accountType,
      verify_status: verification.status || 'pending_verification',
    },
  );

  await recordAction({
    applicationId: row.id,
    actorLabel: 'applicant',
    action: 'save_bank',
    remarks: `Bank saved; verify=${verification.provider}:${verification.status}`,
  });

  const application = await loadApplicationBundle(row.id);
  return { application, verification };
}

export async function acceptAgreements(applicationId, {
  agreements,
  ip = null,
  userAgent = null,
} = {}) {
  await ensureSchema();
  const pool = getPool();
  const row = await getApplicationRow(pool, applicationId);
  if (!row) throw httpError('Application not found', 404);
  assertEditable(row);

  const payload = agreements && typeof agreements === 'object' ? agreements : {};
  await pool.execute(
    `UPDATE agent_applications SET
       agreements_json = CAST(:agreements AS JSONB),
       agreements_accepted_at = NOW(),
       agreements_ip = :ip,
       agreements_user_agent = :ua,
       updated_at = NOW()
     WHERE id = :id`,
    {
      id: row.id,
      agreements: JSON.stringify(payload),
      ip,
      ua: userAgent ? String(userAgent).slice(0, 512) : null,
    },
  );

  await recordAction({
    applicationId: row.id,
    actorLabel: 'applicant',
    action: 'accept_agreements',
    ip,
    userAgent,
  });

  return loadApplicationBundle(row.id);
}

export async function listChecklistForEntity(entityType) {
  await ensureSchema();
  const pool = getPool();
  const type = String(entityType || '').trim().toLowerCase();
  const [rows] = await pool.execute(
    `SELECT * FROM agent_document_checklist_templates
     WHERE is_active = TRUE
       AND (:entity_type = '' OR entity_type = :entity_type)
     ORDER BY entity_type ASC, sort_order ASC`,
    { entity_type: type },
  );
  return rows.map(mapChecklistTemplate);
}

export async function listDocuments(applicationId) {
  await ensureSchema();
  const pool = getPool();
  const row = await getApplicationRow(pool, applicationId);
  if (!row) throw httpError('Application not found', 404);
  const [docs] = await pool.execute(
    `SELECT * FROM agent_application_documents
     WHERE application_id = :id ORDER BY created_at ASC`,
    { id: row.id },
  );
  return docs.map(mapDocument);
}

export async function upsertDocumentMeta(applicationId, documentType, meta = {}) {
  await ensureSchema();
  const pool = getPool();
  const row = await getApplicationRow(pool, applicationId);
  if (!row) throw httpError('Application not found', 404);
  assertEditable(row);

  const docType = String(documentType || meta.documentType || '').trim().toLowerCase();
  if (!docType) throw httpError('document_type is required');

  const [[existing]] = await pool.execute(
    `SELECT * FROM agent_application_documents
     WHERE application_id = :id AND document_type = :doc_type
     ORDER BY created_at DESC LIMIT 1`,
    { id: row.id, doc_type: docType },
  );

  const isMandatory =
    meta.isMandatory != null ? Boolean(meta.isMandatory) : existing?.is_mandatory ?? true;

  if (existing) {
    await pool.execute(
      `UPDATE agent_application_documents SET
         is_mandatory = :is_mandatory,
         document_number = COALESCE(CAST(:document_number AS VARCHAR(128)), document_number),
         issue_date = COALESCE(CAST(:issue_date AS DATE), issue_date),
         expiry_date = COALESCE(CAST(:expiry_date AS DATE), expiry_date),
         updated_at = NOW()
       WHERE id = :id`,
      {
        id: existing.id,
        is_mandatory: isMandatory,
        document_number: meta.documentNumber || meta.document_number || null,
        issue_date: meta.issueDate || meta.issue_date || null,
        expiry_date: meta.expiryDate || meta.expiry_date || null,
      },
    );
    const [[updated]] = await pool.execute(
      `SELECT * FROM agent_application_documents WHERE id = :id LIMIT 1`,
      { id: existing.id },
    );
    return mapDocument(updated);
  }

  const id = newId();
  await pool.execute(
    `INSERT INTO agent_application_documents (
       id, application_id, document_type, is_mandatory, document_number,
       issue_date, expiry_date, status
     ) VALUES (
       :id, :application_id, :document_type, :is_mandatory, :document_number,
       CAST(:issue_date AS DATE), CAST(:expiry_date AS DATE), 'uploaded'
     )`,
    {
      id,
      application_id: row.id,
      document_type: docType,
      is_mandatory: isMandatory,
      document_number: meta.documentNumber || meta.document_number || null,
      issue_date: meta.issueDate || meta.issue_date || null,
      expiry_date: meta.expiryDate || meta.expiry_date || null,
    },
  );
  const [[created]] = await pool.execute(
    `SELECT * FROM agent_application_documents WHERE id = :id LIMIT 1`,
    { id },
  );
  return mapDocument(created);
}

export async function setDocumentFile(applicationId, documentType, filePath, meta = {}) {
  await ensureSchema();
  const pool = getPool();
  const row = await getApplicationRow(pool, applicationId);
  if (!row) throw httpError('Application not found', 404);
  assertEditable(row);

  const docType = String(documentType || '').trim().toLowerCase();
  if (!docType) throw httpError('document_type is required');
  if (!filePath) throw httpError('file is required');

  let checklistMandatory = true;
  if (row.entity_type) {
    const [[tpl]] = await pool.execute(
      `SELECT is_mandatory FROM agent_document_checklist_templates
       WHERE entity_type = :entity_type AND document_type = :doc_type AND is_active = TRUE
       LIMIT 1`,
      { entity_type: row.entity_type, doc_type: docType },
    );
    if (tpl) checklistMandatory = Boolean(tpl.is_mandatory);
  }

  const [[existing]] = await pool.execute(
    `SELECT * FROM agent_application_documents
     WHERE application_id = :id AND document_type = :doc_type
     ORDER BY created_at DESC LIMIT 1`,
    { id: row.id, doc_type: docType },
  );

  if (existing) {
    await pool.execute(
      `UPDATE agent_application_documents SET
         file_path = :file_path,
         document_number = COALESCE(CAST(:document_number AS VARCHAR(128)), document_number),
         issue_date = COALESCE(CAST(:issue_date AS DATE), issue_date),
         expiry_date = COALESCE(CAST(:expiry_date AS DATE), expiry_date),
         status = 'uploaded',
         rejection_reason = NULL,
         uploaded_at = NOW(),
         reviewed_at = NULL,
         reviewed_by = NULL,
         updated_at = NOW()
       WHERE id = :id`,
      {
        id: existing.id,
        file_path: filePath,
        document_number: meta.documentNumber || meta.document_number || null,
        issue_date: meta.issueDate || meta.issue_date || null,
        expiry_date: meta.expiryDate || meta.expiry_date || null,
      },
    );
    const [[updated]] = await pool.execute(
      `SELECT * FROM agent_application_documents WHERE id = :id LIMIT 1`,
      { id: existing.id },
    );
    return mapDocument(updated);
  }

  const id = newId();
  await pool.execute(
    `INSERT INTO agent_application_documents (
       id, application_id, document_type, is_mandatory, document_number,
       issue_date, expiry_date, file_path, status, uploaded_at
     ) VALUES (
       :id, :application_id, :document_type, :is_mandatory, :document_number,
       CAST(:issue_date AS DATE), CAST(:expiry_date AS DATE), :file_path, 'uploaded', NOW()
     )`,
    {
      id,
      application_id: row.id,
      document_type: docType,
      is_mandatory: checklistMandatory,
      document_number: meta.documentNumber || meta.document_number || null,
      issue_date: meta.issueDate || meta.issue_date || null,
      expiry_date: meta.expiryDate || meta.expiry_date || null,
      file_path: filePath,
    },
  );
  const [[created]] = await pool.execute(
    `SELECT * FROM agent_application_documents WHERE id = :id LIMIT 1`,
    { id },
  );
  return mapDocument(created);
}

export async function patchDocumentById(applicationId, documentId, patch = {}) {
  await ensureSchema();
  const pool = getPool();
  const row = await getApplicationRow(pool, applicationId);
  if (!row) throw httpError('Application not found', 404);
  assertEditable(row);

  const [[doc]] = await pool.execute(
    `SELECT * FROM agent_application_documents
     WHERE id = :doc_id AND application_id = :app_id LIMIT 1`,
    { doc_id: documentId, app_id: row.id },
  );
  if (!doc) throw httpError('Document not found', 404);

  await pool.execute(
    `UPDATE agent_application_documents SET
       document_number = COALESCE(CAST(:document_number AS VARCHAR(128)), document_number),
       issue_date = COALESCE(CAST(:issue_date AS DATE), issue_date),
       expiry_date = COALESCE(CAST(:expiry_date AS DATE), expiry_date),
       status = COALESCE(CAST(:status AS VARCHAR(48)), status),
       updated_at = NOW()
     WHERE id = :id`,
    {
      id: doc.id,
      document_number: patch.documentNumber || patch.document_number || null,
      issue_date: patch.issueDate || patch.issue_date || null,
      expiry_date: patch.expiryDate || patch.expiry_date || null,
      status: patch.status || null,
    },
  );

  const [[updated]] = await pool.execute(
    `SELECT * FROM agent_application_documents WHERE id = :id LIMIT 1`,
    { id: doc.id },
  );
  return mapDocument(updated);
}

export async function submitApplication(applicationId, { ip = null, userAgent = null } = {}) {
  await ensureSchema();
  const pool = getPool();
  const row = await getApplicationRow(pool, applicationId);
  if (!row) throw httpError('Application not found', 404);
  assertEditable(row);

  if (!row.entity_type) throw httpError('Entity type is required before submit');
  if (!row.bank_account_number || !row.bank_ifsc) {
    throw httpError('Bank details are required before submit');
  }
  if (!row.agreements_accepted_at) {
    throw httpError('Agreements must be accepted before submit');
  }

  const checklist = await listChecklistForEntity(row.entity_type);
  const mandatory = checklist.filter((c) => c.isMandatory);
  const [docs] = await pool.execute(
    `SELECT document_type, file_path, status FROM agent_application_documents
     WHERE application_id = :id`,
    { id: row.id },
  );
  const uploadedTypes = new Set(
    docs
      .filter((d) => d.file_path && !['rejected'].includes(String(d.status || '')))
      .map((d) => d.document_type),
  );
  const missing = mandatory.filter((c) => !uploadedTypes.has(c.documentType)).map((c) => c.label);
  if (missing.length) {
    throw httpError(`Missing mandatory documents: ${missing.join(', ')}`);
  }

  await pool.execute(
    `UPDATE agent_applications SET
       workflow_status = 'kyc_verification',
       submitted_at = NOW(),
       rejection_reason = NULL,
       updated_at = NOW()
     WHERE id = :id`,
    { id: row.id },
  );

  await recordAction({
    applicationId: row.id,
    actorLabel: 'applicant',
    action: 'submit',
    remarks: 'Application submitted — KYC verification pending',
    ip,
    userAgent,
  });

  const application = await loadApplicationBundle(row.id);

  try {
    const recipients = await getSuperAdminRecipientEmails(pool);
    await sendPartnerApplicationAdminEmail({
      recipients,
      applicant: {
        fullName: row.full_name || application.applicationId,
        email: row.email,
        phone: row.phone,
        panNumber: application.entityPayload?.pan || null,
        bankName: row.bank_name,
        ifscCode: row.bank_ifsc,
      },
    });
  } catch (err) {
    console.warn('[agent-onboarding-admin-email]', err?.message || err);
  }

  return application;
}

export async function adminListApplications({
  status = null,
  entityType = null,
  q = null,
  limit = 100,
  offset = 0,
} = {}) {
  await ensureSchema();
  const pool = getPool();
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const statusFilter = status ? String(status).trim() : '';
  const entityFilter = entityType ? String(entityType).trim().toLowerCase() : '';
  const query = q ? `%${String(q).trim().toLowerCase()}%` : '';

  const [rows] = await pool.execute(
    `SELECT * FROM agent_applications
     WHERE (:status = '' OR workflow_status = :status)
       AND (:entity_type = '' OR entity_type = :entity_type)
       AND (
         :q = ''
         OR LOWER(email) LIKE :q
         OR phone LIKE :q
         OR LOWER(COALESCE(full_name, '')) LIKE :q
         OR LOWER(application_id) LIKE :q
       )
     ORDER BY created_at DESC
     LIMIT ${lim} OFFSET ${off}`,
    {
      status: statusFilter,
      entity_type: entityFilter,
      q: query,
    },
  );

  if (!rows?.length) return [];

  const ids = rows.map((r) => r.id);
  // Batch document stats for dashboard columns (Documents / Risk).
  const placeholders = ids.map((_, i) => `:id${i}`).join(', ');
  const idParams = Object.fromEntries(ids.map((id, i) => [`id${i}`, id]));
  const [docRows] = await pool.execute(
    `SELECT application_id,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE file_path IS NOT NULL AND TRIM(file_path) <> '')::int AS uploaded,
            COUNT(*) FILTER (WHERE status = 'verified')::int AS verified,
            COUNT(*) FILTER (WHERE status IN ('rejected', 'reupload_required'))::int AS rejected,
            STRING_AGG(document_type, ',') FILTER (
              WHERE file_path IS NOT NULL AND TRIM(file_path) <> ''
                AND status NOT IN ('rejected', 'reupload_required')
            ) AS present_types
     FROM agent_application_documents
     WHERE application_id IN (${placeholders})
     GROUP BY application_id`,
    idParams,
  ).catch(() => [[]]);

  const allTemplates = await listChecklistForEntity('').catch(() => []);
  const mandatoryByEntity = new Map();
  allTemplates.filter((t) => t.isMandatory).forEach((t) => {
    const list = mandatoryByEntity.get(t.entityType) || [];
    list.push(String(t.documentType).toLowerCase());
    mandatoryByEntity.set(t.entityType, list);
  });

  const docByApp = new Map(
    (docRows || []).map((d) => [
      d.application_id,
      {
        total: Number(d.total || 0),
        uploaded: Number(d.uploaded || 0),
        verified: Number(d.verified || 0),
        rejected: Number(d.rejected || 0),
        presentTypes: new Set(
          String(d.present_types || '')
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
        ),
      },
    ]),
  );

  return rows.map((r) => {
    const stats = docByApp.get(r.id);
    const mandatory = mandatoryByEntity.get(String(r.entity_type || '').toLowerCase()) || [];
    const present = stats?.presentTypes || new Set();
    const summary = {
      total: stats?.total || 0,
      uploaded: stats?.uploaded || 0,
      verified: stats?.verified || 0,
      rejected: stats?.rejected || 0,
      mandatoryTotal: mandatory.length,
      mandatoryMissing: r.entity_type ? mandatory.filter((t) => !present.has(t)).length : 0,
    };
    return mapApplication(r, { documentSummary: summary });
  });
}

async function attachActorNames(pool, actions = []) {
  const ids = [...new Set(actions.map((a) => a.actorUserId).filter(Boolean))];
  if (!ids.length) return actions;
  const placeholders = ids.map((_, i) => `:u${i}`).join(', ');
  const params = Object.fromEntries(ids.map((id, i) => [`u${i}`, id]));
  const [rows] = await pool.execute(
    `SELECT id, full_name, email FROM user_profiles WHERE id IN (${placeholders})`,
    params,
  ).catch(() => [[]]);
  const byId = new Map((rows || []).map((r) => [r.id, r]));
  return actions.map((a) => {
    const u = a.actorUserId ? byId.get(a.actorUserId) : null;
    return {
      ...a,
      actorName: u?.full_name || u?.email || null,
      actorEmail: u?.email || null,
    };
  });
}

export async function adminGetApplication(idOrPublicId) {
  const app = await loadApplicationBundle(idOrPublicId);
  if (!app) throw httpError('Application not found', 404);
  const pool = getPool();
  const checklist = app.entityType ? await listChecklistForEntity(app.entityType) : [];
  app.actions = await attachActorNames(pool, app.actions || []);
  app.review = buildReviewSummary(app, checklist);
  app.documentSummary = {
    total: app.documents.length,
    uploaded: app.review.documents.uploaded,
    verified: app.documents.filter((d) => d.status === 'verified').length,
    rejected: app.review.documents.rejected,
    mandatoryMissing: app.review.documents.mandatoryMissing,
  };
  app.risk = computeApplicationRisk(app);
  return app;
}

async function setDocumentReview(pool, documentId, applicationId, {
  status,
  rejectionReason = null,
  reviewerUserId = null,
}) {
  const [[doc]] = await pool.execute(
    `SELECT * FROM agent_application_documents
     WHERE id = :id AND application_id = :app LIMIT 1`,
    { id: documentId, app: applicationId },
  );
  if (!doc) throw httpError('Document not found', 404);
  await pool.execute(
    `UPDATE agent_application_documents SET
       status = :status,
       rejection_reason = :reason,
       reviewed_at = NOW(),
       reviewed_by = :by,
       updated_at = NOW()
     WHERE id = :id`,
    {
      id: documentId,
      status,
      reason: rejectionReason,
      by: reviewerUserId,
    },
  );
}

export async function activateAgent(applicationId, reviewerUserId) {
  await ensureSchema();
  await ensureOnboardingSchema();
  const pool = getPool();
  const row = await getApplicationRow(pool, applicationId);
  if (!row) throw httpError('Application not found', 404);

  const status = String(row.workflow_status || '');
  if (status === 'activated' && row.activated_user_id) {
    return {
      applicationId: row.id,
      userId: row.activated_user_id,
      agentCode: row.assigned_agent_code,
      alreadyActivated: true,
    };
  }
  if (![
    'approved', 'submitted', 'under_review', 'bank_verified', 'on_hold',
    'kyc_verification', 'business_verification', 'compliance_review',
  ].includes(status)) {
    throw httpError(`Cannot activate from status '${status}'`);
  }

  if (row.activated_user_id && row.assigned_agent_code) {
    await pool.execute(
      `UPDATE agent_applications SET workflow_status = 'activated', updated_at = NOW() WHERE id = :id`,
      { id: row.id },
    );
    return {
      applicationId: row.id,
      userId: row.activated_user_id,
      agentCode: row.assigned_agent_code,
      alreadyActivated: true,
    };
  }

  const [[existingUser]] = await pool.execute(
    `SELECT au.id, up.role
     FROM auth_users au
     LEFT JOIN user_profiles up ON up.id = au.id
     WHERE au.email = :email LIMIT 1`,
    { email: row.email },
  );
  if (existingUser && existingUser.role && existingUser.role !== 'customer') {
    throw httpError('An account with this email already exists', 409);
  }

  const financialYear = getIndianFinancialYearLabel();
  const { code: agentCode } = await reserveUniqueAgentCodeForFy(pool, financialYear);
  const username = sanitizeUsername((row.email || '').split('@')[0]);
  // Prefer applicant's chosen password so activation preserves their credentials.
  const password = generateTempPassword();

  let agentUserId;
  if (existingUser) {
    // Upgrade customer → agent (reuse partner registration pattern)
    const passwordHash = await bcrypt.hash(password, 12);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(`UPDATE auth_users SET password_hash = :ph WHERE id = :id`, {
        ph: passwordHash,
        id: existingUser.id,
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
        { id: existingUser.id, fullName: row.full_name || '', phone: row.phone || '' },
      );
      const [[existingOnb]] = await conn.execute(
        `SELECT id FROM agent_onboarding WHERE user_id = :id LIMIT 1`,
        { id: existingUser.id },
      );
      const onbParams = {
        user_id: existingUser.id,
        username,
        agent_name: row.full_name || username,
        agent_code: agentCode,
        email: row.email,
        mobile: row.phone,
        acc: row.bank_account_number,
        bank: row.bank_name,
        ifsc: String(row.bank_ifsc || '').toUpperCase(),
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
      agentUserId = existingUser.id;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } else {
    const agentRow = await createAgentAccount(
      {
        username,
        password,
        email: row.email,
        mobileNumber: row.phone,
        agentName: row.full_name || username,
        agentCode,
        accountNumber: row.bank_account_number,
        bankName: row.bank_name,
        ifscCode: row.bank_ifsc,
      },
      reviewerUserId,
      { skipWelcomeEmail: true },
    );
    agentUserId = agentRow.id;
  }

  // Preserve applicant password on the new agent auth account when no customer upgrade.
  if (!existingUser) {
    await pool.execute(`UPDATE auth_users SET password_hash = :ph WHERE id = :id`, {
      ph: row.password_hash,
      id: agentUserId,
    });
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
    `UPDATE agent_applications SET
       workflow_status = 'activated',
       activated_user_id = :userId,
       assigned_agent_code = :code,
       updated_at = NOW()
     WHERE id = :id`,
    { id: row.id, userId: agentUserId, code: agentCode },
  );

  await recordAction({
    applicationId: row.id,
    actorUserId: reviewerUserId,
    actorLabel: 'admin',
    action: 'activate',
    remarks: `Activated agent ${agentCode}`,
  });

  await sendPartnerWelcomeEmail({
    email: row.email,
    fullName: row.full_name,
    username,
    password: existingUser ? password : '(your application password)',
    agentCode,
    financialYear,
  }).catch((err) => console.warn('[agent-onboarding-welcome]', err?.message));

  await writeAuditLog({
    userId: reviewerUserId,
    actionType: 'APPROVE',
    tableName: 'agent_applications',
    recordId: row.id,
    newValues: { agentCode, userId: agentUserId, email: row.email },
  });

  return {
    applicationId: row.id,
    publicApplicationId: row.application_id,
    userId: agentUserId,
    agentCode,
    financialYear,
    username,
  };
}

async function assertReadyForApproval(applicationId, actionLabel) {
  const app = await adminGetApplication(applicationId);
  if (!app.review?.readyForApproval) {
    const list = (app.review?.blockers || []).slice(0, 8).join('; ');
    throw httpError(`Cannot ${actionLabel} yet — pending checks: ${list}`, 409);
  }
  return app;
}

async function saveFieldCheck(pool, row, { field, result, remarks, actorUserId }) {
  const key = String(field || '').trim();
  if (!/^(entity\.[A-Za-z0-9_]+|party\.[A-Za-z0-9-]+)$/.test(key)) {
    throw httpError('field must be entity.<name> or party.<id>');
  }
  const res = String(result || '').trim().toLowerCase();
  if (!['verified', 'mismatch', 'clear'].includes(res)) {
    throw httpError('result must be verified, mismatch or clear');
  }
  if (res === 'mismatch' && !String(remarks || '').trim()) {
    throw httpError('Remarks are required when marking a mismatch');
  }
  const checks = parseJson(row.field_checks_json, {}) || {};
  if (res === 'clear') delete checks[key];
  else {
    let actorName = null;
    if (actorUserId) {
      const [[u]] = await pool.execute(
        `SELECT full_name, email FROM user_profiles WHERE id = :id LIMIT 1`,
        { id: actorUserId },
      ).catch(() => [[null]]);
      actorName = u?.full_name || u?.email || null;
    }
    checks[key] = {
      result: res,
      remarks: remarks ? String(remarks).slice(0, 500) : null,
      by: actorUserId || null,
      byName: actorName,
      at: new Date().toISOString(),
    };
  }
  await pool.execute(
    `UPDATE agent_applications SET field_checks_json = CAST(:checks AS JSONB), updated_at = NOW()
     WHERE id = :id`,
    { id: row.id, checks: JSON.stringify(checks) },
  );
  return key;
}

async function notifyApplicantStatus(row, act, remarks) {
  const subjects = {
    send_back: 'Action needed: your Rfincare partner application was sent back',
    request_document: 'Action needed: please re-upload documents for your Rfincare partner application',
    reject_document: 'Action needed: a document in your Rfincare partner application was rejected',
    approve: 'Your Rfincare partner application is approved',
    hold: 'Your Rfincare partner application is on hold',
  };
  const subject = subjects[act];
  if (!subject || !row?.email) return;
  const base = (process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '');
  const statusUrl = `${base}/agent-application-status`;
  const needsAction = ['send_back', 'request_document', 'reject_document'].includes(act);
  const lines = [
    `Hello ${row.full_name || row.email},`,
    '',
    `Application ID: ${row.application_id}`,
    act === 'approve'
      ? 'Your application has been approved. Your agent account will be activated shortly.'
      : act === 'hold'
        ? 'Your application has been placed on hold by our review team.'
        : 'Our review team needs you to update your application.',
    remarks ? `Remarks: ${remarks}` : '',
    needsAction ? `Log in to update your application: ${statusUrl}` : `Track your status: ${statusUrl}`,
    '',
    '— Rfincare Team',
  ].filter((l) => l !== null);
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = lines
    .filter(Boolean)
    .map((l) => `<p>${esc(l)}</p>`)
    .join('');
  await sendEmail({ to: row.email, subject, text: lines.join('\n'), html });
}

export async function adminTransition(applicationId, {
  action,
  remarks = null,
  documentId = null,
  field = null,
  result = null,
  actorUserId = null,
  actorLabel = 'admin',
  ip = null,
  userAgent = null,
} = {}) {
  await ensureSchema();
  const pool = getPool();
  const row = await getApplicationRow(pool, applicationId);
  if (!row) throw httpError('Application not found', 404);

  const act = String(action || '').trim().toLowerCase();
  let nextStatus = row.workflow_status;
  let extra = null;
  let auditRemarks = remarks;

  const STAGE_ORDER = [
    'kyc_verification',
    'business_verification',
    'compliance_review',
    'approved',
  ];

  switch (act) {
    case 'approve':
      await assertReadyForApproval(row.id, 'approve');
      nextStatus = 'approved';
      break;
    case 'advance':
    case 'advance_stage': {
      // submitted (legacy) → kyc → business → compliance → approved
      const current = row.workflow_status === 'submitted' || row.workflow_status === 'under_review'
        ? 'kyc_verification'
        : row.workflow_status;
      const idx = STAGE_ORDER.indexOf(current);
      if (idx < 0 || idx >= STAGE_ORDER.length - 1) {
        throw httpError(`Cannot advance from status '${row.workflow_status}'`);
      }
      nextStatus = STAGE_ORDER[idx + 1];
      if (nextStatus === 'approved') await assertReadyForApproval(row.id, 'approve');
      break;
    }
    case 'reject':
      nextStatus = 'rejected';
      break;
    case 'send_back':
      nextStatus = 'sent_back';
      break;
    case 'request_document':
      if (documentId) {
        await setDocumentReview(pool, documentId, row.id, {
          status: 'reupload_required',
          rejectionReason: remarks || 'Please re-upload this document',
          reviewerUserId: actorUserId,
        });
      }
      nextStatus = 'reupload_required';
      break;
    case 'hold':
      nextStatus = 'on_hold';
      break;
    case 'suspend':
      nextStatus = 'suspended';
      break;
    case 'verify_field': {
      const key = await saveFieldCheck(pool, row, { field, result, remarks, actorUserId });
      auditRemarks = `${key}: ${String(result || '').toLowerCase()}${remarks ? ` — ${remarks}` : ''}`;
      break;
    }
    case 'mark_bank_verified':
      if (!row.bank_account_number || !row.bank_ifsc) {
        throw httpError('Applicant has not submitted bank details yet');
      }
      await pool.execute(
        `UPDATE agent_applications SET
           bank_verify_status = 'verified',
           bank_verified_at = NOW(),
           bank_verified_by = :by,
           updated_at = NOW()
         WHERE id = :id`,
        { id: row.id, by: actorUserId || null },
      );
      nextStatus = ['submitted', 'under_review', 'kyc_verification'].includes(row.workflow_status)
        ? 'business_verification'
        : row.workflow_status;
      break;
    case 'verify_document':
      if (!documentId) throw httpError('documentId is required');
      await setDocumentReview(pool, documentId, row.id, {
        status: 'verified',
        reviewerUserId: actorUserId,
      });
      nextStatus = row.workflow_status === 'submitted' ? 'kyc_verification' : row.workflow_status;
      break;
    case 'reject_document':
      if (!documentId) throw httpError('documentId is required');
      await setDocumentReview(pool, documentId, row.id, {
        status: 'rejected',
        rejectionReason: remarks || 'Document rejected',
        reviewerUserId: actorUserId,
      });
      nextStatus = 'reupload_required';
      break;
    case 'activate':
      if (!(row.workflow_status === 'activated' && row.activated_user_id)) {
        await assertReadyForApproval(row.id, 'activate');
      }
      extra = await activateAgent(row.id, actorUserId);
      nextStatus = 'activated';
      break;
    default:
      throw httpError(`Unsupported action: ${act}`);
  }

  if (act !== 'activate' && act !== 'verify_field') {
    const setsReason = ['rejected', 'sent_back', 'reupload_required'].includes(nextStatus);
    await pool.execute(
      `UPDATE agent_applications SET
         workflow_status = :status,
         ${setsReason ? 'rejection_reason = :remarks,' : ''}
         updated_at = NOW()
       WHERE id = :id`,
      setsReason
        ? { id: row.id, status: nextStatus, remarks: remarks || null }
        : { id: row.id, status: nextStatus },
    );
  }

  await recordAction({
    applicationId: row.id,
    actorUserId,
    actorLabel,
    action: act,
    remarks: auditRemarks,
    ip,
    userAgent,
  });

  if (act === 'reject') {
    await sendPartnerRejectionEmail({
      email: row.email,
      fullName: row.full_name,
      reason: remarks,
    }).catch((err) => console.warn('[agent-onboarding-reject]', err?.message));
  } else {
    await notifyApplicantStatus(row, act, remarks)
      .catch((err) => console.warn('[agent-onboarding-notify]', err?.message));
  }

  const application = await adminGetApplication(row.id);
  return { application, result: extra };
}

export async function replaceChecklistTemplates(templates = []) {
  await ensureSchema();
  const pool = getPool();
  if (!Array.isArray(templates)) throw httpError('templates must be an array');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(`DELETE FROM agent_document_checklist_templates`);
    let sort = 0;
    for (const t of templates) {
      const entityType = String(t.entityType || t.entity_type || '').trim().toLowerCase();
      const documentType = String(t.documentType || t.document_type || '').trim().toLowerCase();
      if (!ENTITY_TYPES.has(entityType)) throw httpError(`Invalid entity_type: ${entityType}`);
      if (!documentType) throw httpError('document_type is required');
      await conn.execute(
        `INSERT INTO agent_document_checklist_templates (
           id, entity_type, document_type, label, is_mandatory, max_size_mb, sort_order, is_active
         ) VALUES (
           :id, :entity_type, :document_type, :label, :is_mandatory, :max_size_mb, :sort_order, :is_active
         )`,
        {
          id: t.id || newId(),
          entity_type: entityType,
          document_type: documentType,
          label: String(t.label || documentType),
          is_mandatory: t.isMandatory != null ? Boolean(t.isMandatory) : true,
          max_size_mb: Number(t.maxSizeMb || t.max_size_mb || 10),
          sort_order: t.sortOrder != null ? Number(t.sortOrder) : sort,
          is_active: t.isActive != null ? Boolean(t.isActive) : true,
        },
      );
      sort += 1;
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return listChecklistForEntity('');
}

export async function listApplicationActions(applicationId) {
  await ensureSchema();
  const pool = getPool();
  const row = await getApplicationRow(pool, applicationId);
  if (!row) throw httpError('Application not found', 404);
  const [actions] = await pool.execute(
    `SELECT * FROM agent_application_actions
     WHERE ${sqlParamEquals('application_id', 'id')}
     ORDER BY created_at DESC LIMIT 200`,
    { id: row.id },
  );
  return actions.map(mapAction);
}
