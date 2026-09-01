import { Router } from 'express';
import { z } from 'zod';

import { getPool, isDuplicateEntryError, isDuplicateColumnError, isNoSuchTableError, isIgnorableMigrationError, isTableExistsError, isBadFieldError } from '../db/pool.js';
import { newId } from '../lib/ids.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { ensureStaffMessagingSchema } from '../db/ensureStaffMessagingSchema.js';
import { sendEmail, smtpConfigured } from '../lib/email.js';
import { writeAuditLog } from '../lib/audit.js';
import { ensureAgentCodeForUser } from '../lib/agentCode.js';
import { resolveUploadFilePath } from '../lib/uploadPaths.js';
import {
  canEmployeeAccessCustomerSupportChat,
  listSupportChatThreads,
  listCustomerSupportMessages,
  replyAsSupport,
} from '../lib/customerSupportChat.js';

export const staffCommunicationRouter = Router();
export const adminHierarchyRouter = Router();

const STAFF_ROLES = new Set(['admin', 'super_admin', 'employee', 'agent']);

function agentApplicationScopeSql(alias = 'la') {
  return `(
    ${alias}.agent_id = :agent_id
    OR (
      :agent_code IS NOT NULL
      AND ${alias}.sourced_agent_code IS NOT NULL
      AND ${alias}.sourced_agent_code = :agent_code
    )
  )`;
}

async function resolveAgentScopeParams(pool, agentUserId) {
  const agentCode = (await ensureAgentCodeForUser(pool, agentUserId)) || null;
  return { agent_id: agentUserId, agent_code: agentCode };
}

async function resolveAgentUserIdFromApplication(pool, app) {
  if (app?.agent_id) return app.agent_id;
  if (!app?.sourced_agent_code) return null;
  const [[row]] = await pool.execute(
    `SELECT user_id FROM agent_onboarding WHERE agent_code = :code LIMIT 1`,
    { code: app.sourced_agent_code },
  );
  return row?.user_id || null;
}

async function agentCanAccessApplication(pool, agentUserId, applicationId) {
  if (!applicationId) return null;
  const scope = await resolveAgentScopeParams(pool, agentUserId);
  const [[row]] = await pool.execute(
    `SELECT agent_id, assigned_employee_id, sourced_agent_code
     FROM loan_applications
     WHERE id = :id AND ${agentApplicationScopeSql('loan_applications')}
     LIMIT 1`,
    { id: applicationId, ...scope },
  );
  return row || null;
}

function pairThreadKey(userIdA, userIdB) {
  const sorted = [userIdA, userIdB].sort().join(':');
  return `pair:${sorted}`;
}

function threadKeyForPair(userIdA, userIdB) {
  return pairThreadKey(userIdA, userIdB);
}

function messagePairParams(userId, peerId) {
  const sorted = [userId, peerId].sort().join(':');
  return {
    pairKey: pairThreadKey(userId, peerId),
    appThreadPattern: `app:%:${sorted}`,
    userId,
    peerId,
  };
}

function messagePairSql() {
  return `(
    thread_key = :pairKey
    OR thread_key LIKE :appThreadPattern
    OR (
      sender_id IN (:userId, :peerId)
      AND recipient_id IN (:userId, :peerId)
    )
  )`;
}

async function fetchHierarchyMapping(pool, agentUserId, employeeUserId = null) {
  const params = { agentUserId };
  let extra = '';
  if (employeeUserId) {
    extra = ' AND employee_user_id = :employeeUserId';
    params.employeeUserId = employeeUserId;
  }
  const [rows] = await pool.execute(
    `SELECT h.*,
            ag.full_name AS agent_name, ag.email AS agent_email,
            em.full_name AS employee_name, em.email AS employee_email,
            COALESCE(eo.mobile_number, em.phone) AS employee_phone
     FROM agent_employee_hierarchy h
     LEFT JOIN user_profiles ag ON ag.id = h.agent_user_id
     LEFT JOIN user_profiles em ON em.id = h.employee_user_id
     LEFT JOIN employee_onboarding eo ON eo.user_id = h.employee_user_id
     WHERE h.agent_user_id = :agentUserId${extra}
     ORDER BY h.is_primary DESC, h.hierarchy_level ASC, h.created_at ASC`,
    params,
  );
  return rows;
}

async function resolvePeerForUser(pool, userId, role, applicationId = null) {
  if (applicationId) {
    let app = null;
    if (role === 'agent') {
      app = await agentCanAccessApplication(pool, userId, applicationId);
    } else if (role === 'employee') {
      const [[row]] = await pool.execute(
        `SELECT agent_id, assigned_employee_id, sourced_agent_code
         FROM loan_applications
         WHERE id = :applicationId AND assigned_employee_id = :employeeId
         LIMIT 1`,
        { applicationId, employeeId: userId },
      );
      app = row || null;
    } else {
      const [[row]] = await pool.execute(
        `SELECT agent_id, assigned_employee_id, sourced_agent_code
         FROM loan_applications WHERE id = :id LIMIT 1`,
        { id: applicationId },
      );
      app = row || null;
    }

    if (app) {
      if (role === 'agent' && app.assigned_employee_id) {
        const mappings = await fetchHierarchyMapping(pool, userId, app.assigned_employee_id);
        const map = mappings[0];
        const [[emp]] = await pool.execute(
          `SELECT id, full_name, email FROM user_profiles WHERE id = :id LIMIT 1`,
          { id: app.assigned_employee_id },
        );
        if (emp?.id) {
          return {
            peerId: emp.id,
            peerName: emp.full_name,
            peerEmail: emp.email,
            communicationEmail: map?.communication_email || emp.email,
            applicationId,
          };
        }
      }

      if (role === 'employee') {
        const agentUserId = await resolveAgentUserIdFromApplication(pool, app);
        if (agentUserId) {
          const mappings = await fetchHierarchyMapping(pool, agentUserId, userId);
          const map = mappings[0];
          const [[agent]] = await pool.execute(
            `SELECT id, full_name, email FROM user_profiles WHERE id = :id LIMIT 1`,
            { id: agentUserId },
          );
          if (agent?.id) {
            return {
              peerId: agent.id,
              peerName: agent.full_name,
              peerEmail: agent.email,
              communicationEmail: map?.communication_email || agent.email,
              applicationId,
            };
          }
        }
      }
    }
  }

  if (role === 'agent') {
    const mappings = await fetchHierarchyMapping(pool, userId);
    const primary = mappings.find((m) => m.is_primary) || mappings[0];
    if (!primary) return null;
    return {
      peerId: primary.employee_user_id,
      peerName: primary.employee_name,
      peerEmail: primary.employee_email,
      communicationEmail: primary.communication_email || primary.employee_email,
      hierarchyLevel: primary.hierarchy_level,
      mappings,
    };
  }

  if (role === 'employee') {
    const [rows] = await pool.execute(
      `SELECT h.*, ag.full_name AS agent_name, ag.email AS agent_email
       FROM agent_employee_hierarchy h
       LEFT JOIN user_profiles ag ON ag.id = h.agent_user_id
       WHERE h.employee_user_id = :id
       ORDER BY h.is_primary DESC, h.hierarchy_level ASC`,
      { id: userId },
    );
    const primary = rows.find((m) => m.is_primary) || rows[0];
    if (!primary) return null;
    return {
      peerId: primary.agent_user_id,
      peerName: primary.agent_name,
      peerEmail: primary.agent_email,
      communicationEmail: primary.communication_email || primary.agent_email,
      hierarchyLevel: primary.hierarchy_level,
      mappings: rows,
    };
  }

  return null;
}

function getPublicApiBaseUrl() {
  return (
    process.env.API_PUBLIC_URL
    || process.env.APP_PUBLIC_URL
    || 'http://127.0.0.1:8080'
  ).replace(/\/$/, '');
}

function formatAttachmentRow(att) {
  const documentId = att.document_id || att.documentId || null;
  const storedUrl = att.file_url || att.fileUrl || '';
  const fileUrl = documentId
    ? `/documents/${documentId}/download`
    : storedUrl.startsWith('/documents/')
      ? storedUrl
      : storedUrl;
  return {
    id: att.id,
    documentId,
    fileName: att.file_name || att.fileName,
    fileUrl,
    documentType: att.document_type || att.documentType,
    mimeType: att.mime_type || att.mimeType,
  };
}

function formatMessageRow(row, attachments = [], extra = {}) {
  return {
    id: row.id,
    threadKey: row.thread_key,
    applicationId: row.application_id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    subject: row.subject,
    body: row.body,
    channel: row.channel,
    emailTo: row.email_to,
    createdAt: row.created_at,
    readAt: row.read_at,
    attachments: attachments.map(formatAttachmentRow),
    ...extra,
  };
}

async function buildEmailFileAttachments(pool, documentIds = []) {
  const files = [];
  for (const docId of documentIds) {
    const [[doc]] = await pool.execute(
      `SELECT document_name, file_path, document_url, mime_type
       FROM customer_documents WHERE id = :id LIMIT 1`,
      { id: docId },
    );
    if (!doc) continue;
    const resolvedPath = resolveUploadFilePath(doc.file_path, [
      doc.document_name,
      doc.document_url,
    ]);
    if (!resolvedPath) continue;
    files.push({
      filename: doc.document_name || `document-${docId}`,
      path: resolvedPath,
      contentType: doc.mime_type || undefined,
    });
  }
  return files;
}

// ——— Admin hierarchy CRUD ———

adminHierarchyRouter.get(
  '/',
  authenticate,
  authorize({ resource: 'agents', action: 'read' }),
  async (req, res, next) => {
    try {
      await ensureStaffMessagingSchema();
      const pool = getPool();
      const [rows] = await pool.execute(
        `SELECT h.*,
                ag.full_name AS agent_name, ag.email AS agent_email, ao.agent_code,
                em.full_name AS employee_name, em.email AS employee_email, eo.employee_code
         FROM agent_employee_hierarchy h
         LEFT JOIN user_profiles ag ON ag.id = h.agent_user_id
         LEFT JOIN agent_onboarding ao ON ao.user_id = h.agent_user_id
         LEFT JOIN user_profiles em ON em.id = h.employee_user_id
         LEFT JOIN employee_onboarding eo ON eo.user_id = h.employee_user_id
         ORDER BY h.is_primary DESC, h.hierarchy_level ASC, ag.full_name ASC`,
      );
      res.json(
        rows.map((r) => ({
          id: r.id,
          agentUserId: r.agent_user_id,
          employeeUserId: r.employee_user_id,
          agentName: r.agent_name,
          agentEmail: r.agent_email,
          agentCode: r.agent_code,
          employeeName: r.employee_name,
          employeeEmail: r.employee_email,
          employeeCode: r.employee_code,
          communicationEmail: r.communication_email,
          hierarchyLevel: r.hierarchy_level,
          isPrimary: Boolean(r.is_primary),
          notes: r.notes,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
      );
    } catch (err) {
      next(err);
    }
  },
);

const HierarchySchema = z.object({
  agentUserId: z.string().min(1),
  employeeUserId: z.string().min(1),
  communicationEmail: z.string().email(),
  hierarchyLevel: z.number().int().min(1).max(10).optional(),
  isPrimary: z.boolean().optional(),
  notes: z.string().optional(),
});

adminHierarchyRouter.post(
  '/',
  authenticate,
  authorize({ resource: 'agents', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureStaffMessagingSchema();
      const input = HierarchySchema.parse(req.body);
      const pool = getPool();
      const id = newId();

      if (input.isPrimary) {
        await pool.execute(
          `UPDATE agent_employee_hierarchy SET is_primary = 0 WHERE agent_user_id = :agentId`,
          { agentId: input.agentUserId },
        );
      }

      await pool.execute(
        `INSERT INTO agent_employee_hierarchy
         (id, agent_user_id, employee_user_id, communication_email, hierarchy_level, is_primary, notes, created_by)
         VALUES
         (:id, :agent_user_id, :employee_user_id, :communication_email, :hierarchy_level, :is_primary, :notes, :created_by)`,
        {
          id,
          agent_user_id: input.agentUserId,
          employee_user_id: input.employeeUserId,
          communication_email: input.communicationEmail,
          hierarchy_level: input.hierarchyLevel ?? 1,
          is_primary: input.isPrimary ? 1 : 0,
          notes: input.notes || null,
          created_by: req.auth.userId,
        },
      );

      await writeAuditLog({
        userId: req.auth.userId,
        actionType: 'create',
        tableName: 'agent_employee_hierarchy',
        recordId: id,
        newValues: input,
      });

      res.status(201).json({ id });
    } catch (err) {
      if (isDuplicateEntryError(err)) {
        return res.status(409).json({ error: 'This agent is already mapped to that employee' });
      }
      next(err);
    }
  },
);

adminHierarchyRouter.patch(
  '/:id',
  authenticate,
  authorize({ resource: 'agents', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureStaffMessagingSchema();
      const input = HierarchySchema.partial().parse(req.body);
      const pool = getPool();

      const [[existing]] = await pool.execute(
        `SELECT * FROM agent_employee_hierarchy WHERE id = :id LIMIT 1`,
        { id: req.params.id },
      );
      if (!existing) return res.status(404).json({ error: 'Mapping not found' });

      if (input.isPrimary) {
        await pool.execute(
          `UPDATE agent_employee_hierarchy SET is_primary = 0 WHERE agent_user_id = :agentId`,
          { agentId: existing.agent_user_id },
        );
      }

      await pool.execute(
        `UPDATE agent_employee_hierarchy SET
          communication_email = COALESCE(:communication_email, communication_email),
          hierarchy_level = COALESCE(:hierarchy_level, hierarchy_level),
          is_primary = COALESCE(:is_primary, is_primary),
          notes = COALESCE(:notes, notes)
         WHERE id = :id`,
        {
          id: req.params.id,
          communication_email: input.communicationEmail || null,
          hierarchy_level: input.hierarchyLevel ?? null,
          is_primary: input.isPrimary == null ? null : input.isPrimary ? 1 : 0,
          notes: input.notes ?? null,
        },
      );

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

adminHierarchyRouter.delete(
  '/:id',
  authenticate,
  authorize({ resource: 'agents', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureStaffMessagingSchema();
      const pool = getPool();
      const [result] = await pool.execute(
        `DELETE FROM agent_employee_hierarchy WHERE id = :id`,
        { id: req.params.id },
      );
      if (result.affectedRows === 0) return res.status(404).json({ error: 'Mapping not found' });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

const HIERARCHY_CSV_HEADER =
  'agent_code,agent_name,location,level1_name,level1_email,level1_mobile,level2_name,level2_email,level2_mobile,level3_name,level3_email,level3_mobile,office_address';

adminHierarchyRouter.get(
  '/template.csv',
  authenticate,
  authorize({ resource: 'agents', action: 'read' }),
  async (_req, res) => {
    const sample = [
      HIERARCHY_CSV_HEADER,
      'AG001,Sample Agent,Mumbai,L1 Manager,l1@example.com,9876543210,L2 Manager,l2@example.com,9876543211,L3 Manager,l3@example.com,9876543212,Head Office',
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="escalation-matrix-template.csv"');
    res.send(sample);
  },
);

adminHierarchyRouter.post(
  '/import.csv',
  authenticate,
  authorize({ resource: 'agents', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureStaffMessagingSchema();
      const raw = String(req.body?.csv || req.body?.content || '');
      if (!raw.trim()) {
        return res.status(400).json({ error: 'CSV content is required (field: csv)' });
      }
      const lines = raw
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length < 2) {
        return res.status(400).json({ error: 'CSV must include a header and at least one data row' });
      }

      const parseRow = (line) => {
        const cols = [];
        let cur = '';
        let inQ = false;
        for (let i = 0; i < line.length; i += 1) {
          const ch = line[i];
          if (ch === '"') {
            inQ = !inQ;
            continue;
          }
          if (ch === ',' && !inQ) {
            cols.push(cur.trim());
            cur = '';
            continue;
          }
          cur += ch;
        }
        cols.push(cur.trim());
        return cols;
      };

      const header = parseRow(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
      const idx = (name) => header.indexOf(name);
      const pool = getPool();
      const results = { created: 0, updated: 0, skipped: 0, errors: [] };

      const resolveEmployee = async (email, name) => {
        const em = String(email || '').trim().toLowerCase();
        if (!em) return null;
        const [[byEmail]] = await pool.execute(
          `SELECT id, email FROM user_profiles WHERE LOWER(email) = :email AND role = 'employee' LIMIT 1`,
          { email: em },
        );
        if (byEmail) return byEmail;
        if (name) {
          const [[byName]] = await pool.execute(
            `SELECT id, email FROM user_profiles WHERE LOWER(full_name) = LOWER(:name) AND role = 'employee' LIMIT 1`,
            { name: String(name).trim() },
          );
          return byName || null;
        }
        return null;
      };

      const upsertLevel = async (agentUserId, employee, level, isPrimary, location, officeAddress) => {
        const [[existing]] = await pool.execute(
          `SELECT id FROM agent_employee_hierarchy
           WHERE agent_user_id = :agent AND employee_user_id = :emp LIMIT 1`,
          { agent: agentUserId, emp: employee.id },
        );
        const notes = [location && `Location: ${location}`, officeAddress && `Office: ${officeAddress}`]
          .filter(Boolean)
          .join(' | ') || null;
        if (isPrimary) {
          await pool.execute(
            `UPDATE agent_employee_hierarchy SET is_primary = 0 WHERE agent_user_id = :agentId`,
            { agentId: agentUserId },
          );
        }
        if (existing) {
          await pool.execute(
            `UPDATE agent_employee_hierarchy SET
              communication_email = :email,
              hierarchy_level = :level,
              is_primary = :primary,
              notes = COALESCE(:notes, notes)
             WHERE id = :id`,
            {
              id: existing.id,
              email: employee.email,
              level,
              primary: isPrimary ? 1 : 0,
              notes,
            },
          );
          results.updated += 1;
        } else {
          await pool.execute(
            `INSERT INTO agent_employee_hierarchy
             (id, agent_user_id, employee_user_id, communication_email, hierarchy_level, is_primary, notes, created_by)
             VALUES (:id, :agent, :emp, :email, :level, :primary, :notes, :created_by)`,
            {
              id: newId(),
              agent: agentUserId,
              emp: employee.id,
              email: employee.email,
              level,
              primary: isPrimary ? 1 : 0,
              notes,
              created_by: req.auth.userId,
            },
          );
          results.created += 1;
        }
      };

      for (let i = 1; i < lines.length; i += 1) {
        const cols = parseRow(lines[i]);
        const get = (name) => {
          const j = idx(name);
          return j >= 0 ? cols[j] || '' : '';
        };
        const agentCode = get('agent_code');
        if (!agentCode) {
          results.skipped += 1;
          results.errors.push({ row: i + 1, error: 'Missing agent_code' });
          continue;
        }
        const [[agent]] = await pool.execute(
          `SELECT ao.user_id AS id FROM agent_onboarding ao WHERE UPPER(ao.agent_code) = UPPER(:code) LIMIT 1`,
          { code: agentCode },
        );
        if (!agent?.id) {
          results.skipped += 1;
          results.errors.push({ row: i + 1, error: `Unknown agent_code ${agentCode}` });
          continue;
        }

        const location = get('location');
        const officeAddress = get('office_address');
        const levels = [
          { level: 1, name: get('level1_name'), email: get('level1_email'), mobile: get('level1_mobile') },
          { level: 2, name: get('level2_name'), email: get('level2_email'), mobile: get('level2_mobile') },
          { level: 3, name: get('level3_name'), email: get('level3_email'), mobile: get('level3_mobile') },
        ];

        let primarySet = false;
        for (const lv of levels) {
          if (!lv.email && !lv.name) continue;
          const emp = await resolveEmployee(lv.email, lv.name);
          if (!emp) {
            results.errors.push({
              row: i + 1,
              error: `Level ${lv.level} employee not found (${lv.email || lv.name})`,
            });
            continue;
          }
          await upsertLevel(agent.id, emp, lv.level, !primarySet, location, officeAddress);
          primarySet = true;
        }
        if (!primarySet) {
          results.skipped += 1;
          results.errors.push({ row: i + 1, error: 'No valid L1/L2/L3 employees on row' });
        }
      }

      res.json(results);
    } catch (err) {
      next(err);
    }
  },
);

// ——— Portal communication (agent + employee) ———

staffCommunicationRouter.use(authenticate);

staffCommunicationRouter.get('/context', async (req, res, next) => {
  try {
    if (!STAFF_ROLES.has(req.auth.role)) {
      const e = new Error('Staff access only');
      e.status = 403;
      throw e;
    }
    await ensureStaffMessagingSchema();
    const pool = getPool();
    const applicationId = req.query.applicationId || null;
    const peer = await resolvePeerForUser(pool, req.auth.userId, req.auth.role, applicationId);

    let applications = [];
    if (req.auth.role === 'agent') {
      const scope = await resolveAgentScopeParams(pool, req.auth.userId);
      const [apps] = await pool.execute(
        `SELECT la.id, la.application_number, c.full_name AS customer_name
         FROM loan_applications la
         LEFT JOIN user_profiles c ON c.id = la.customer_id
         WHERE ${agentApplicationScopeSql('la')}
         ORDER BY la.updated_at DESC LIMIT 50`,
        scope,
      );
      applications = apps.map((a) => ({
        id: a.id,
        applicationNumber: a.application_number,
        customerName: a.customer_name,
      }));
    } else if (req.auth.role === 'employee') {
      const [apps] = await pool.execute(
        `SELECT la.id, la.application_number, c.full_name AS customer_name
         FROM loan_applications la
         LEFT JOIN user_profiles c ON c.id = la.customer_id
         WHERE la.assigned_employee_id = :id
         ORDER BY la.updated_at DESC LIMIT 50`,
        { id: req.auth.userId },
      );
      applications = apps.map((a) => ({
        id: a.id,
        applicationNumber: a.application_number,
        customerName: a.customer_name,
      }));
    }

    const hierarchyRows =
      req.auth.role === 'agent'
        ? await fetchHierarchyMapping(pool, req.auth.userId)
        : [];

    res.json({
      role: req.auth.role,
      peer: peer
        ? {
            id: peer.peerId,
            name: peer.peerName,
            email: peer.peerEmail,
            communicationEmail: peer.communicationEmail,
            hierarchyLevel: peer.hierarchyLevel,
          }
        : null,
      hierarchy: hierarchyRows.map((r) => ({
        employeeUserId: r.employee_user_id,
        employeeName: r.employee_name,
        employeeEmail: r.employee_email,
        employeePhone: r.employee_phone || null,
        communicationEmail: r.communication_email,
        hierarchyLevel: r.hierarchy_level,
        isPrimary: Boolean(r.is_primary),
      })),
      applications,
      canCommunicate: Boolean(peer?.peerId),
    });
  } catch (err) {
    next(err);
  }
});

staffCommunicationRouter.get('/messages', async (req, res, next) => {
  try {
    if (!STAFF_ROLES.has(req.auth.role)) {
      const e = new Error('Staff access only');
      e.status = 403;
      throw e;
    }
    await ensureStaffMessagingSchema();
    const pool = getPool();
    const peerId = req.query.peerId;

    if (!peerId) {
      return res.status(400).json({ error: 'peerId is required' });
    }

    const threadParams = messagePairParams(req.auth.userId, peerId);
    const [rows] = await pool.execute(
      `SELECT * FROM staff_messages
       WHERE ${messagePairSql()}
       ORDER BY created_at ASC
       LIMIT 200`,
      threadParams,
    );

    const messageIds = rows.map((r) => r.id);
    let attachmentsByMessage = {};
    if (messageIds.length) {
      const placeholders = messageIds.map((_, i) => `:id${i}`).join(',');
      const attParams = Object.fromEntries(messageIds.map((id, i) => [`id${i}`, id]));
      const [atts] = await pool.execute(
        `SELECT * FROM staff_message_attachments WHERE message_id IN (${placeholders})`,
        attParams,
      );
      attachmentsByMessage = atts.reduce((acc, att) => {
        if (!acc[att.message_id]) acc[att.message_id] = [];
        acc[att.message_id].push({
          id: att.id,
          documentId: att.document_id,
          fileName: att.file_name,
          fileUrl: att.file_url,
          documentType: att.document_type,
          mimeType: att.mime_type,
        });
        return acc;
      }, {});
    }

    await pool.execute(
      `UPDATE staff_messages SET read_at = NOW()
       WHERE recipient_id = :userId AND read_at IS NULL
       AND ${messagePairSql()}`,
      { ...threadParams, userId: req.auth.userId },
    );

    res.json(rows.map((r) => formatMessageRow(r, attachmentsByMessage[r.id] || [])));
  } catch (err) {
    next(err);
  }
});

const SendMessageSchema = z.object({
  peerId: z.string().min(1),
  applicationId: z.string().optional(),
  subject: z.string().max(255).optional(),
  body: z.string().min(1),
  channel: z.enum(['internal', 'email']).optional(),
  documentIds: z.array(z.string()).optional(),
});

staffCommunicationRouter.post('/messages', async (req, res, next) => {
  try {
    if (!STAFF_ROLES.has(req.auth.role)) {
      const e = new Error('Staff access only');
      e.status = 403;
      throw e;
    }
    await ensureStaffMessagingSchema();
    const input = SendMessageSchema.parse(req.body);
    const pool = getPool();

    const peer = await resolvePeerForUser(
      pool,
      req.auth.userId,
      req.auth.role,
      input.applicationId || null,
    );
    if (!peer?.peerId || peer.peerId !== input.peerId) {
      const [[target]] = await pool.execute(
        `SELECT id, role, email FROM user_profiles WHERE id = :id LIMIT 1`,
        { id: input.peerId },
      );
      if (!target) return res.status(404).json({ error: 'Recipient not found' });

      if (!['admin', 'super_admin'].includes(req.auth.role)) {
        let mapped = false;
        if (req.auth.role === 'agent' && target.role === 'employee') {
          const [[row]] = await pool.execute(
            `SELECT id FROM agent_employee_hierarchy
             WHERE agent_user_id = :agentId AND employee_user_id = :employeeId LIMIT 1`,
            { agentId: req.auth.userId, employeeId: input.peerId },
          );
          mapped = Boolean(row);
        } else if (req.auth.role === 'employee' && target.role === 'agent') {
          const [[row]] = await pool.execute(
            `SELECT id FROM agent_employee_hierarchy
             WHERE employee_user_id = :employeeId AND agent_user_id = :agentId LIMIT 1`,
            { employeeId: req.auth.userId, agentId: input.peerId },
          );
          mapped = Boolean(row);
        }
        if (!mapped) {
          return res.status(403).json({ error: 'You can only message your mapped hierarchy contact' });
        }
      }
    }

    const communicationEmail =
      peer?.communicationEmail
      || (await pool.execute(`SELECT email FROM user_profiles WHERE id = :id`, { id: input.peerId }))[0][0]
        ?.email;

    const channel = input.channel || 'internal';
    const messageId = newId();
    const threadKey = threadKeyForPair(req.auth.userId, input.peerId);

    await pool.execute(
      `INSERT INTO staff_messages
       (id, thread_key, application_id, sender_id, recipient_id, subject, body, channel, email_to)
       VALUES
       (:id, :thread_key, :application_id, :sender_id, :recipient_id, :subject, :body, :channel, :email_to)`,
      {
        id: messageId,
        thread_key: threadKey,
        application_id: input.applicationId || null,
        sender_id: req.auth.userId,
        recipient_id: input.peerId,
        subject: input.subject || null,
        body: input.body,
        channel,
        email_to: channel === 'email' ? communicationEmail : null,
      },
    );

    const documentIds = input.documentIds || [];
    const attachments = [];
    for (const docId of documentIds) {
      const [[doc]] = await pool.execute(
        `SELECT cd.*, la.agent_id, la.assigned_employee_id, la.sourced_agent_code
         FROM customer_documents cd
         LEFT JOIN loan_applications la ON la.id = cd.application_id
         WHERE cd.id = :id LIMIT 1`,
        { id: docId },
      );
      if (!doc) continue;
      let canAttach =
        req.auth.role === 'admin'
        || req.auth.role === 'super_admin'
        || (req.auth.role === 'employee' && doc.assigned_employee_id === req.auth.userId);
      if (!canAttach && req.auth.role === 'agent') {
        const scope = await resolveAgentScopeParams(pool, req.auth.userId);
        canAttach =
          doc.agent_id === req.auth.userId
          || (
            scope.agent_code
            && doc.sourced_agent_code
            && doc.sourced_agent_code === scope.agent_code
          );
      }
      if (!canAttach) continue;

      const attId = newId();
      const fileUrl = `/documents/${doc.id}/download`;
      await pool.execute(
        `INSERT INTO staff_message_attachments
         (id, message_id, document_id, file_name, file_url, document_type, mime_type)
         VALUES (:id, :message_id, :document_id, :file_name, :file_url, :document_type, :mime_type)`,
        {
          id: attId,
          message_id: messageId,
          document_id: doc.id,
          file_name: doc.document_name,
          file_url: fileUrl,
          document_type: doc.document_type,
          mime_type: doc.mime_type,
        },
      );
      attachments.push({
        id: attId,
        documentId: doc.id,
        fileName: doc.document_name,
        fileUrl,
        documentType: doc.document_type,
        mimeType: doc.mime_type,
      });
    }

    let emailDelivery = null;
    if (channel === 'email' && communicationEmail) {
      const apiBase = getPublicApiBaseUrl();
      const portalUrl = (process.env.APP_PUBLIC_URL || apiBase).replace(/\/$/, '');
      const attachLines = attachments.length
        ? attachments
            .map((a) => {
              const link = a.documentId
                ? `${apiBase}/documents/${a.documentId}/download`
                : a.fileUrl?.startsWith('http')
                  ? a.fileUrl
                  : `${apiBase}${a.fileUrl?.startsWith('/') ? a.fileUrl : `/${a.fileUrl || ''}`}`;
              return `- ${a.fileName}: ${link}`;
            })
            .join('\n')
        : '';
      const emailSubject = input.subject || 'Rfincare — message from your assigned contact';
      const emailText = [
        input.body,
        '',
        attachLines ? 'Attached documents (also included as email attachments when available):\n' + attachLines : '',
        '',
        `Open Rfincare: ${portalUrl}`,
        '',
        '— Rfincare Staff Communication',
      ]
        .filter((line, idx, arr) => !(line === '' && arr[idx + 1] === ''))
        .join('\n');

      const emailHtml = `
        <p>${String(input.body).replace(/\n/g, '<br/>')}</p>
        ${
          attachLines
            ? `<p><strong>Documents</strong></p><ul>${attachments
                .map((a) => {
                  const link = a.documentId
                    ? `${apiBase}/documents/${a.documentId}/download`
                    : `${apiBase}${a.fileUrl || ''}`;
                  return `<li><a href="${link}">${a.fileName || 'Document'}</a></li>`;
                })
                .join('')}</ul>`
            : ''
        }
        <p><a href="${portalUrl}">Open Rfincare</a></p>
        <p>— Rfincare Staff Communication</p>
      `;

      const emailAttachments = await buildEmailFileAttachments(pool, documentIds);
      emailDelivery = await sendEmail({
        to: communicationEmail,
        subject: emailSubject,
        text: emailText,
        html: emailHtml,
        attachments: emailAttachments,
      });
      emailDelivery = {
        ...emailDelivery,
        to: communicationEmail,
        smtpConfigured: smtpConfigured(),
      };
    }

    const [[row]] = await pool.execute(`SELECT * FROM staff_messages WHERE id = :id`, { id: messageId });
    res.status(201).json(
      formatMessageRow(row, attachments, emailDelivery ? { emailDelivery } : {}),
    );
  } catch (err) {
    next(err);
  }
});

staffCommunicationRouter.get('/documents', async (req, res, next) => {
  try {
    if (!STAFF_ROLES.has(req.auth.role)) {
      const e = new Error('Staff access only');
      e.status = 403;
      throw e;
    }
    const applicationId = req.query.applicationId;
    if (!applicationId) {
      return res.status(400).json({ error: 'applicationId is required' });
    }

    const pool = getPool();
    let app = null;
    if (req.auth.role === 'agent') {
      app = await agentCanAccessApplication(pool, req.auth.userId, applicationId);
    } else {
      const [[row]] = await pool.execute(
        `SELECT agent_id, assigned_employee_id, customer_id
         FROM loan_applications WHERE id = :id LIMIT 1`,
        { id: applicationId },
      );
      app = row || null;
    }
    if (!app) return res.status(404).json({ error: 'Application not found' });

    const allowed =
      ['admin', 'super_admin'].includes(req.auth.role)
      || (req.auth.role === 'employee' && app.assigned_employee_id === req.auth.userId)
      || req.auth.role === 'agent';
    if (!allowed) {
      return res.status(403).json({ error: 'Insufficient permissions for this application' });
    }

    const [rows] = await pool.execute(
      `SELECT id, document_type, document_name, mime_type, document_url, verification_status, status, uploaded_at
       FROM customer_documents
       WHERE application_id = :applicationId
       ORDER BY uploaded_at DESC`,
      { applicationId },
    );

    res.json(
      rows.map((r) => ({
        id: r.id,
        documentType: r.document_type,
        documentName: r.document_name,
        mimeType: r.mime_type,
        fileUrl: r.document_url || `/documents/${r.id}/download`,
        verificationStatus: r.verification_status || r.status,
        uploadedAt: r.uploaded_at,
      })),
    );
  } catch (err) {
    next(err);
  }
});

staffCommunicationRouter.get('/unread-count', async (req, res, next) => {
  try {
    if (!STAFF_ROLES.has(req.auth.role)) {
      const e = new Error('Staff access only');
      e.status = 403;
      throw e;
    }
    await ensureStaffMessagingSchema();
    const pool = getPool();
    const [[row]] = await pool.execute(
      `SELECT COUNT(*) AS cnt FROM staff_messages
       WHERE recipient_id = :userId AND read_at IS NULL`,
      { userId: req.auth.userId },
    );
    res.json({ count: Number(row?.cnt || 0) });
  } catch (err) {
    next(err);
  }
});

staffCommunicationRouter.get('/support-chats', async (req, res, next) => {
  try {
    if (!['admin', 'super_admin', 'employee'].includes(req.auth.role)) {
      const e = new Error('Employee access only');
      e.status = 403;
      throw e;
    }
    const threads = await listSupportChatThreads({
      limit: Number(req.query.limit) || 40,
      role: req.auth.role,
      userId: req.auth.userId,
    });
    res.json({ threads });
  } catch (err) {
    next(err);
  }
});

staffCommunicationRouter.get('/support-chats/:customerId', async (req, res, next) => {
  try {
    if (!['admin', 'super_admin', 'employee'].includes(req.auth.role)) {
      const e = new Error('Employee access only');
      e.status = 403;
      throw e;
    }
    if (req.auth.role === 'employee') {
      const allowed = await canEmployeeAccessCustomerSupportChat(
        req.auth.userId,
        req.params.customerId,
      );
      if (!allowed) {
        return res.status(403).json({ error: 'You can only view chats for your assigned applications.' });
      }
    }
    const messages = await listCustomerSupportMessages(req.params.customerId, {
      seedWelcome: false,
    });
    res.json({ messages });
  } catch (err) {
    next(err);
  }
});

staffCommunicationRouter.post('/support-chats/:customerId', async (req, res, next) => {
  try {
    if (!['admin', 'super_admin', 'employee'].includes(req.auth.role)) {
      const e = new Error('Employee access only');
      e.status = 403;
      throw e;
    }
    if (req.auth.role === 'employee') {
      const allowed = await canEmployeeAccessCustomerSupportChat(
        req.auth.userId,
        req.params.customerId,
      );
      if (!allowed) {
        return res.status(403).json({ error: 'You can only reply to chats for your assigned applications.' });
      }
    }
    const body = String(req.body?.body || req.body?.message || '').trim();
    const message = await replyAsSupport({
      customerId: req.params.customerId,
      senderId: req.auth.userId,
      body,
    });
    res.status(201).json({ message });
  } catch (err) {
    next(err);
  }
});
