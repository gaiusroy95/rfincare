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
    },
    agreements: parseJson(row.agreements_json, null),
    agreementsAcceptedAt: row.agreements_accepted_at,
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
         full_name, state, city, pin_code, referral_code
       ) VALUES (
         :id, :application_id, 'draft', :email, :phone, :password_hash,
         :full_name, :state, :city, :pin_code, :referral_code
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
    remarks: 'Draft application created',
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
            COUNT(*) FILTER (WHERE status IN ('rejected', 'reupload_required'))::int AS rejected
     FROM agent_application_documents
     WHERE application_id IN (${placeholders})
     GROUP BY application_id`,
    idParams,
  ).catch(() => [[]]);

  const docByApp = new Map(
    (docRows || []).map((d) => [
      d.application_id,
      {
        total: Number(d.total || 0),
        uploaded: Number(d.uploaded || 0),
        verified: Number(d.verified || 0),
        rejected: Number(d.rejected || 0),
        mandatoryMissing: 0,
      },
    ]),
  );

  return rows.map((r) => {
    const summary = docByApp.get(r.id) || {
      total: 0,
      uploaded: 0,
      verified: 0,
      rejected: 0,
      mandatoryMissing: 0,
    };
    return mapApplication(r, { documentSummary: summary });
  });
}

export async function adminGetApplication(idOrPublicId) {
  const app = await loadApplicationBundle(idOrPublicId);
  if (!app) throw httpError('Application not found', 404);
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
  if (!['approved', 'submitted', 'under_review', 'bank_verified', 'on_hold'].includes(status)) {
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

export async function adminTransition(applicationId, {
  action,
  remarks = null,
  documentId = null,
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

  const STAGE_ORDER = [
    'kyc_verification',
    'business_verification',
    'compliance_review',
    'approved',
  ];

  switch (act) {
    case 'approve':
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
      break;
    }
    case 'reject':
      nextStatus = 'rejected';
      break;
    case 'send_back':
      nextStatus = 'sent_back';
      break;
    case 'request_document':
      nextStatus = 'reupload_required';
      break;
    case 'hold':
      nextStatus = 'on_hold';
      break;
    case 'suspend':
      nextStatus = 'suspended';
      break;
    case 'mark_bank_verified':
      await pool.execute(
        `UPDATE agent_applications SET bank_verify_status = 'verified', updated_at = NOW() WHERE id = :id`,
        { id: row.id },
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
      extra = await activateAgent(row.id, actorUserId);
      nextStatus = 'activated';
      break;
    default:
      throw httpError(`Unsupported action: ${act}`);
  }

  if (act !== 'activate') {
    await pool.execute(
      `UPDATE agent_applications SET
         workflow_status = :status,
         rejection_reason = CASE
           WHEN :status = 'rejected' THEN CAST(:remarks AS TEXT)
           WHEN :status IN ('sent_back', 'reupload_required') THEN CAST(:remarks AS TEXT)
           ELSE rejection_reason
         END,
         updated_at = NOW()
       WHERE id = :id`,
      {
        id: row.id,
        status: nextStatus,
        remarks: remarks || null,
      },
    );
  }

  await recordAction({
    applicationId: row.id,
    actorUserId,
    actorLabel,
    action: act,
    remarks,
    ip,
    userAgent,
  });

  if (act === 'reject') {
    await sendPartnerRejectionEmail({
      email: row.email,
      fullName: row.full_name,
      reason: remarks,
    }).catch((err) => console.warn('[agent-onboarding-reject]', err?.message));
  }

  const application = await loadApplicationBundle(row.id);
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
