import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { getPool } from '../db/pool.js';
import { ensureOnboardingSchema } from '../db/ensureOnboardingSchema.js';
import { createAgentAccount, createEmployeeAccount } from '../lib/staffOnboarding.js';
import { backfillMissingAgentCodes, ensureAgentCodeForUser } from '../lib/agentCode.js';
import { ensureMilestone3Schema } from '../db/ensureMilestone3Schema.js';
import { assignUniqueCustomerCode } from '../lib/customerCode.js';
import { writeAuditLog } from '../lib/audit.js';
import { newId } from '../lib/ids.js';
import { ensureStaffExtrasSchema } from '../db/ensureStaffExtrasSchema.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { approvalMatrixRouter } from './approvalMatrixRules.js';
import { statusCheckAdminRouter } from './statusCheckAdmin.js';
import { adminHierarchyRouter } from './staffMessaging.js';
import {
  fetchAgentDetail,
  fetchEmployeeDetail,
  updateAgentDetails,
  updateEmployeeDetails,
  resetStaffPassword,
} from '../lib/adminStaffManage.js';
import { parseCsvToRows } from '../lib/parseCsv.js';
import {
  buildAgentCommissionTemplateCsv,
  importAgentCommissionRows,
  mapCommissionConfigRow,
  normalizeCommissionCsvRow,
  upsertAgentCommissionConfig,
} from '../lib/agentCommission.js';

export const adminRouter = Router();

adminRouter.use('/hierarchy', adminHierarchyRouter);

const uploadRoot = process.env.UPLOAD_DIR || './uploads';
const circularDir = resolve(uploadRoot, 'commission-circulars');
mkdirSync(circularDir, { recursive: true });
const circularUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, circularDir),
    filename: (_req, file, cb) => {
      const safe = `${Date.now()}-${Math.random().toString(36).slice(2)}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      cb(null, safe);
    },
  }),
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf');
    cb(ok ? null : new Error('Only PDF files are allowed'), ok);
  },
  limits: { fileSize: 20 * 1024 * 1024 },
});

const commissionBulkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function wrapMulter(uploadMiddleware) {
  return (req, res, next) => {
    uploadMiddleware(req, res, (err) => {
      if (!err) return next();
      err.status = err.status || 400;
      next(err);
    });
  };
}

function storeCircularUploads(files = []) {
  const map = {};
  for (const f of files) {
    const safe = f.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}-${safe}`;
    const fullPath = resolve(circularDir, filename);
    writeFileSync(fullPath, f.buffer);
    const storedUrl = `/uploads/commission-circulars/${filename}`;
    map[f.originalname] = { storedUrl, filename };
    map[f.originalname.toLowerCase()] = { storedUrl, filename };
    map[basename(f.originalname)] = { storedUrl, filename };
    map[basename(f.originalname).toLowerCase()] = { storedUrl, filename };
  }
  return map;
}

adminRouter.use('/status-check', statusCheckAdminRouter);

/** Alias: /admin/approval-matrix-rules (same handlers as /approval-matrix-rules) */
adminRouter.use('/approval-matrix-rules', approvalMatrixRouter);

function mapAgentProfile(row) {
  const agentCode = row.agent_code || null;
  return {
    id: row.id,
    email: row.email,
    agent_name: row.full_name,
    agent_code: agentCode,
    username: row.username || null,
    onboarding_status: row.ao_status || row.onboarding_status || row.account_status || 'pending',
    created_at: row.created_at,
    agent: {
      total_clients: row.total_clients ?? 0,
      total_commission: row.total_commission ?? 0,
      success_rate: row.success_rate ?? 0,
    },
    user_profile: {
      role: row.role,
      is_active: Boolean(row.is_active),
    },
  };
}

function mapEmployeeProfile(row) {
  const employeeCode =
    row.employee_code ||
    (row.id ? `EMP-${String(row.id).slice(0, 8).toUpperCase()}` : 'N/A');
  return {
    id: row.id,
    email: row.email,
    employee_name: row.full_name,
    employee_code: employeeCode,
    username: row.username || null,
    onboarding_status: row.eo_status || row.onboarding_status || row.account_status || 'pending',
    created_at: row.created_at,
    user_profile: {
      role: row.role,
      is_active: Boolean(row.is_active),
    },
    access_controls: [],
  };
}

adminRouter.get(
  '/stats',
  authenticate,
  authorize({ resource: 'reports', action: 'read' }),
  async (req, res, next) => {
    try {
      const pool = getPool();

      const [[appStats]] = await pool.execute(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status IN ('submitted', 'pending', 'under_review') THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved
         FROM loan_applications`,
      );

      const [[agentStats]] = await pool.execute(
        `SELECT COUNT(*) AS active_agents
         FROM user_profiles
         WHERE role = 'agent' AND is_active = 1 AND account_status = 'active'`,
      );

      const total = Number(appStats?.total || 0);
      const approved = Number(appStats?.approved || 0);
      const approvalRate =
        total > 0 ? `${((approved / total) * 100).toFixed(1)}%` : '0%';

      res.json({
        total_applications: total,
        pending_reviews: Number(appStats?.pending || 0),
        active_agents: Number(agentStats?.active_agents || 0),
        approval_rate: approvalRate,
      });
    } catch (err) {
      next(err);
    }
  },
);

/** Combined employees + agents for lead assignment dropdowns */
adminRouter.get(
  '/assignees',
  authenticate,
  authorize({ resource: 'agents', action: 'read' }),
  async (req, res, next) => {
    try {
      await ensureOnboardingSchema();
      const pool = getPool();
      await backfillMissingAgentCodes(pool);

      const [employees] = await pool.execute(
        `SELECT up.id, up.full_name, up.email, up.account_status, up.onboarding_status,
                eo.employee_code, eo.username
         FROM user_profiles up
         LEFT JOIN employee_onboarding eo ON eo.user_id = up.id
         WHERE up.role = 'employee'
         ORDER BY up.full_name ASC, up.email ASC`,
      );

      const [agents] = await pool.execute(
        `SELECT up.id, up.full_name, up.email, up.account_status, up.onboarding_status,
                ao.agent_code, ao.username
         FROM user_profiles up
         LEFT JOIN agent_onboarding ao ON ao.user_id = up.id
         WHERE up.role = 'agent'
         ORDER BY up.full_name ASC, up.email ASC`,
      );

      const mapStaff = (row, role) => {
        const code =
          role === 'agent'
            ? row.agent_code || '—'
            : row.employee_code || `EMP-${String(row.id).slice(0, 8).toUpperCase()}`;
        const name = row.full_name || row.email || 'Staff';
        return {
          id: row.id,
          role,
          name,
          code,
          email: row.email,
          username: row.username || null,
          status: row.onboarding_status || row.account_status || 'pending',
          label: `${code} — ${name}`,
        };
      };

      res.json({
        employees: employees.map((r) => mapStaff(r, 'employee')),
        agents: agents.map((r) => mapStaff(r, 'agent')),
        all: [
          ...employees.map((r) => mapStaff(r, 'employee')),
          ...agents.map((r) => mapStaff(r, 'agent')),
        ],
      });
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.get(
  '/agents',
  authenticate,
  authorize({ resource: 'agents', action: 'read' }),
  async (req, res, next) => {
    try {
      const pool = getPool();
      await ensureOnboardingSchema();
      await backfillMissingAgentCodes(pool);
      const [rows] = await pool.execute(
        `SELECT up.*,
                ao.agent_code,
                ao.username,
                ao.onboarding_status AS ao_status,
                (SELECT COUNT(*) FROM loan_applications la WHERE la.agent_id = up.id) AS total_clients,
                0 AS total_commission,
                0 AS success_rate
         FROM user_profiles up
         LEFT JOIN agent_onboarding ao ON ao.user_id = up.id
         WHERE up.role = 'agent'
         ORDER BY up.created_at DESC`,
      );
      res.json(
        rows.map((row) =>
          mapAgentProfile({
            ...row,
            agent_code: row.agent_code || null,
          }),
        ),
      );
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.get(
  '/employees',
  authenticate,
  authorize({ resource: 'employees', action: 'read' }),
  async (req, res, next) => {
    try {
      const pool = getPool();
      await ensureOnboardingSchema();
      const [rows] = await pool.execute(
        `SELECT up.*,
                eo.employee_code,
                eo.username,
                eo.onboarding_status AS eo_status
         FROM user_profiles up
         LEFT JOIN employee_onboarding eo ON eo.user_id = up.id
         WHERE up.role = 'employee'
         ORDER BY up.created_at DESC`,
      );
      res.json(rows.map(mapEmployeeProfile));
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.post(
  '/agents',
  authenticate,
  authorize({ resource: 'agents', action: 'manage' }),
  async (req, res, next) => {
    try {
      const row = await createAgentAccount(req.body, req.auth.userId);
      res.status(201).json(mapAgentProfile(row));
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.post(
  '/employees',
  authenticate,
  authorize({ resource: 'employees', action: 'manage' }),
  async (req, res, next) => {
    try {
      const row = await createEmployeeAccount(req.body, req.auth.userId);
      res.status(201).json(mapEmployeeProfile(row));
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.get(
  '/agents/:id',
  authenticate,
  authorize({ resource: 'agents', action: 'read' }),
  async (req, res, next) => {
    try {
      const detail = await fetchAgentDetail(req.params.id);
      res.json(detail);
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.patch(
  '/agents/:id',
  authenticate,
  authorize({ resource: 'agents', action: 'update' }),
  async (req, res, next) => {
    try {
      const detail = await updateAgentDetails(req.params.id, req.body);
      await writeAuditLog({
        userId: req.auth.userId,
        actionType: 'update',
        tableName: 'agent_onboarding',
        recordId: req.params.id,
        newValues: { scope: 'admin_agent_update' },
      });
      res.json(detail);
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.post(
  '/agents/:id/reset-password',
  authenticate,
  authorize({ resource: 'agents', action: 'update' }),
  async (req, res, next) => {
    try {
      const { password, notifyEmail } = req.body || {};
      const detail = await fetchAgentDetail(req.params.id);
      await resetStaffPassword({
        userId: req.params.id,
        password,
        role: 'agent',
        fullName: detail.agentName,
        email: detail.email,
        notifyEmail: Boolean(notifyEmail),
      });
      await writeAuditLog({
        userId: req.auth.userId,
        actionType: 'update',
        tableName: 'auth_users',
        recordId: req.params.id,
        newValues: { scope: 'admin_agent_password_reset' },
      });
      res.json({ success: true, message: 'Agent password updated' });
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.get(
  '/employees/:id',
  authenticate,
  authorize({ resource: 'employees', action: 'read' }),
  async (req, res, next) => {
    try {
      const detail = await fetchEmployeeDetail(req.params.id);
      res.json(detail);
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.patch(
  '/employees/:id',
  authenticate,
  authorize({ resource: 'employees', action: 'update' }),
  async (req, res, next) => {
    try {
      const detail = await updateEmployeeDetails(req.params.id, req.body);
      await writeAuditLog({
        userId: req.auth.userId,
        actionType: 'update',
        tableName: 'employee_onboarding',
        recordId: req.params.id,
        newValues: { scope: 'admin_employee_update' },
      });
      res.json(detail);
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.post(
  '/employees/:id/reset-password',
  authenticate,
  authorize({ resource: 'employees', action: 'update' }),
  async (req, res, next) => {
    try {
      const { password, notifyEmail } = req.body || {};
      const detail = await fetchEmployeeDetail(req.params.id);
      await resetStaffPassword({
        userId: req.params.id,
        password,
        role: 'employee',
        fullName: detail.employeeName,
        email: detail.email,
        notifyEmail: Boolean(notifyEmail),
      });
      await writeAuditLog({
        userId: req.auth.userId,
        actionType: 'update',
        tableName: 'auth_users',
        recordId: req.params.id,
        newValues: { scope: 'admin_employee_password_reset' },
      });
      res.json({ success: true, message: 'Employee password updated' });
    } catch (err) {
      next(err);
    }
  },
);

function mapCustomerRow(row) {
  return {
    id: row.id,
    customerCode: row.customer_code,
    fullName: row.full_name,
    email: row.display_email || row.email,
    phone: row.phone,
    accountStatus: row.account_status,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    applicationCount: Number(row.application_count || 0),
  };
}

adminRouter.get(
  '/customers',
  authenticate,
  authorize({ resource: 'customers', action: 'read' }),
  async (req, res, next) => {
    try {
      await ensureMilestone3Schema();
      const pool = getPool();
      const search = req.query.search?.trim();
      let sql = `
        SELECT up.*,
               CASE
                 WHEN up.email LIKE '%@rfincare.customer' OR up.email LIKE '%@oauth.rfincare.local'
                 THEN COALESCE(reg.latest_email, lead.latest_email, up.email)
                 ELSE up.email
               END AS display_email,
               (SELECT COUNT(*) FROM loan_applications la WHERE la.customer_id = up.id) AS application_count
        FROM user_profiles up
        LEFT JOIN (
          SELECT phone, MAX(email) AS latest_email
          FROM customer_registrations
          GROUP BY phone
        ) reg ON reg.phone = up.phone
        LEFT JOIN (
          SELECT phone, MAX(email) AS latest_email
          FROM marketing_leads
          GROUP BY phone
        ) lead ON lead.phone = up.phone
        WHERE up.role = 'customer'`;
      const params = {};
      if (search) {
        sql += ` AND (
          up.full_name LIKE :search OR up.email LIKE :search
          OR up.phone LIKE :search OR up.customer_code LIKE :search
        )`;
        params.search = `%${search}%`;
      }
      sql += ' ORDER BY up.created_at DESC LIMIT 500';
      const [rows] = await pool.execute(sql, params);
      for (const row of rows) {
        if (!row.customer_code) {
          await assignUniqueCustomerCode(pool, row.id);
        }
      }
      const [updated] = await pool.execute(sql, params);
      res.json(updated.map(mapCustomerRow));
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.patch(
  '/customers/:id',
  authenticate,
  authorize({ resource: 'customers', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureMilestone3Schema();
      const pool = getPool();
      const { is_active, account_status } = req.body;
      const isActive = is_active !== undefined ? (is_active ? 1 : 0) : undefined;

      const [[before]] = await pool.execute(
        `SELECT * FROM user_profiles WHERE id = :id AND role = 'customer' LIMIT 1`,
        { id: req.params.id },
      );
      if (!before) {
        const e = new Error('Customer not found');
        e.status = 404;
        throw e;
      }

      if (!before.customer_code) {
        await assignUniqueCustomerCode(pool, req.params.id);
      }

      await pool.execute(
        `UPDATE user_profiles
         SET is_active = COALESCE(:is_active, is_active),
             account_status = COALESCE(:account_status, account_status)
         WHERE id = :id AND role = 'customer'`,
        {
          id: req.params.id,
          is_active: isActive,
          account_status: account_status || null,
        },
      );

      const [[row]] = await pool.execute(
        `SELECT up.*,
                CASE
                  WHEN up.email LIKE '%@rfincare.customer' OR up.email LIKE '%@oauth.rfincare.local'
                  THEN COALESCE(reg.latest_email, lead.latest_email, up.email)
                  ELSE up.email
                END AS display_email,
                (SELECT COUNT(*) FROM loan_applications la WHERE la.customer_id = up.id) AS application_count
         FROM user_profiles up
         LEFT JOIN (
           SELECT phone, MAX(email) AS latest_email
           FROM customer_registrations
           GROUP BY phone
         ) reg ON reg.phone = up.phone
         LEFT JOIN (
           SELECT phone, MAX(email) AS latest_email
           FROM marketing_leads
           GROUP BY phone
         ) lead ON lead.phone = up.phone
         WHERE up.id = :id LIMIT 1`,
        { id: req.params.id },
      );

      await writeAuditLog({
        userId: req.auth.userId,
        actionType: 'UPDATE',
        tableName: 'user_profiles',
        recordId: req.params.id,
        oldValues: {
          is_active: before.is_active,
          account_status: before.account_status,
        },
        newValues: { is_active: row.is_active, account_status: row.account_status },
      });

      res.json(mapCustomerRow(row));
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.get(
  '/agents/commission/csv-template',
  authenticate,
  authorize({ resource: 'agents', action: 'read' }),
  (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="agent-commission-template.csv"');
    res.send(buildAgentCommissionTemplateCsv());
  },
);

adminRouter.post(
  '/agents/commission/bulk-csv',
  authenticate,
  authorize({ resource: 'agents', action: 'update' }),
  wrapMulter(
    commissionBulkUpload.fields([
      { name: 'file', maxCount: 1 },
      { name: 'circulars', maxCount: 50 },
    ]),
  ),
  async (req, res, next) => {
    try {
      await ensureStaffExtrasSchema();
      const csvFile = req.files?.file?.[0];
      if (!csvFile) return res.status(400).json({ error: 'CSV file is required (field name: file)' });

      const text = csvFile.buffer.toString('utf8');
      const rawRows = parseCsvToRows(text);
      const circularFilesByName = storeCircularUploads(req.files?.circulars || []);
      const pool = getPool();
      const summary = await importAgentCommissionRows(pool, rawRows, {
        updatedBy: req.auth.userId,
        circularFilesByName,
      });

      await writeAuditLog({
        userId: req.auth.userId,
        actionType: 'BULK_IMPORT',
        tableName: 'agent_commission_config',
        recordId: null,
        newValues: { imported: summary.imported, failed: summary.failed },
      });

      res.json(summary);
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.get(
  '/agents/:id/commission',
  authenticate,
  authorize({ resource: 'agents', action: 'read' }),
  async (req, res, next) => {
    try {
      await ensureStaffExtrasSchema();
      const pool = getPool();
      const [rows] = await pool.execute(
        `SELECT * FROM agent_commission_config
         WHERE agent_user_id = :id
         ORDER BY loan_type ASC, updated_at DESC`,
        { id: req.params.id },
      );
      if (rows.length) {
        return res.json(rows.map(mapCommissionConfigRow));
      }
      const [[fallback]] = await pool.execute(
        `SELECT * FROM global_commission_config WHERE id = 'default' LIMIT 1`,
      );
      res.json(fallback ? [mapCommissionConfigRow({ ...fallback, agent_user_id: req.params.id })] : []);
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.put(
  '/agents/:id/commission',
  authenticate,
  authorize({ resource: 'agents', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureStaffExtrasSchema();
      const pool = getPool();
      const [[agent]] = await pool.execute(
        `SELECT ao.agent_code, ao.agent_name, up.id
         FROM user_profiles up
         LEFT JOIN agent_onboarding ao ON ao.user_id = up.id
         WHERE up.id = :id AND up.role = 'agent' LIMIT 1`,
        { id: req.params.id },
      );
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      const agentCode =
        (await ensureAgentCodeForUser(pool, req.params.id)) || agent.agent_code || '';
      const body = req.body || {};
      const row = normalizeCommissionCsvRow({
        agent_code: agentCode || body.agentCode || body.agent_code || '',
        agent_name: agent.agent_name || body.agentName || body.agent_name || '',
        loan_type: body.loanType || body.loan_type || 'home_loan',
        commission_type: body.commissionType || body.commission_type || 'percentage',
        commission_value: String(body.commissionValue ?? body.commission_value ?? 2.5),
        min_loan_amount: body.minLoanAmount ?? body.min_loan_amount ?? '',
        max_loan_amount: body.maxLoanAmount ?? body.max_loan_amount ?? '',
        effective_from: body.effectiveFrom || body.effective_from || '',
        effective_to: body.effectiveTo || body.effective_to || '',
        circular_title: body.circularTitle || body.circular_title || '',
        upload: body.circularFileUrl || body.circular_file_url || body.upload || '',
      });

      const configId = await upsertAgentCommissionConfig(pool, req.params.id, row, {
        updatedBy: req.auth.userId,
      });

      await writeAuditLog({
        userId: req.auth.userId,
        actionType: 'UPDATE',
        tableName: 'agent_commission_config',
        recordId: configId,
        newValues: body,
      });

      res.json({ ok: true, configId });
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.get(
  '/commission/circulars',
  authenticate,
  authorize({ resource: 'agents', action: 'read' }),
  async (_req, res, next) => {
    try {
      await ensureStaffExtrasSchema();
      const pool = getPool();
      const [rows] = await pool.execute(
        `SELECT id, title, description, file_name, file_url, is_active, created_at
         FROM agent_commission_circulars
         WHERE is_active = 1
         ORDER BY created_at DESC`,
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.post(
  '/commission/circulars',
  authenticate,
  authorize({ resource: 'agents', action: 'update' }),
  circularUpload.single('file'),
  async (req, res, next) => {
    try {
      await ensureStaffExtrasSchema();
      if (!req.file) return res.status(400).json({ error: 'PDF file is required' });
      const pool = getPool();
      const id = newId();
      const title = req.body?.title?.trim() || req.file.originalname;
      const description = req.body?.description?.trim() || null;
      const fileUrl = `/uploads/commission-circulars/${req.file.filename}`;
      await pool.execute(
        `INSERT INTO agent_commission_circulars
         (id, title, description, file_name, file_path, file_url, uploaded_by)
         VALUES (:id, :title, :description, :file_name, :file_path, :file_url, :uploaded_by)`,
        {
          id,
          title,
          description,
          file_name: req.file.originalname,
          file_path: req.file.path,
          file_url: fileUrl,
          uploaded_by: req.auth.userId,
        },
      );
      res.status(201).json({ id, title, description, fileUrl });
    } catch (err) {
      next(err);
    }
  },
);

adminRouter.get(
  '/employees/:id/access-controls',
  authenticate,
  authorize({ resource: 'employees', action: 'read' }),
  async (req, res, next) => {
    try {
      await ensureStaffExtrasSchema();
      const pool = getPool();
      const [rows] = await pool.execute(
        `SELECT * FROM employee_access_controls WHERE employee_user_id = :id`,
        { id: req.params.id },
      );
      res.json(
        rows.map((r) => {
          let permissions = r.permissions_json;
          if (typeof permissions === 'string') {
            try {
              permissions = JSON.parse(permissions);
            } catch {
              permissions = [];
            }
          }
          return {
            moduleName: r.module_name,
            permissions: permissions || [],
            isActive: Boolean(r.is_active),
            expiresAt: r.expires_at,
          };
        }),
      );
    } catch (err) {
      next(err);
    }
  },
);

async function upsertEmployeeModuleAccess(pool, employeeUserId, entry, { isActive, expiresAt, updatedBy }) {
  const moduleName = entry.moduleName || entry.module_name;
  const permissions = entry.permissions || [];
  const rowActive = isActive && permissions.length > 0;

  await pool.execute(
    `INSERT INTO employee_access_controls (
       id, employee_user_id, module_name, permissions_json, is_active, expires_at, updated_by
     ) VALUES (
       :id, :employee_user_id, :module_name, :permissions_json, :is_active, :expires_at, :updated_by
     )
     ON DUPLICATE KEY UPDATE
       permissions_json = VALUES(permissions_json),
       is_active = VALUES(is_active),
       expires_at = VALUES(expires_at),
       updated_by = VALUES(updated_by)`,
    {
      id: newId(),
      employee_user_id: employeeUserId,
      module_name: moduleName,
      permissions_json: JSON.stringify(permissions),
      is_active: rowActive ? 1 : 0,
      expires_at: expiresAt,
      updated_by: updatedBy,
    },
  );
}

adminRouter.put(
  '/employees/:id/access-controls',
  authenticate,
  authorize({ resource: 'employees', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureStaffExtrasSchema();
      const pool = getPool();
      const input = req.body || {};
      const isActive = input.isActive !== false && input.is_active !== false;
      const expiresAt = input.expiresAt || input.expires_at || null;

      const modules = Array.isArray(input.modules)
        ? input.modules
        : [
            {
              moduleName: input.moduleName || input.module_name || 'applications',
              permissions: input.permissions || [],
            },
          ];

      for (const entry of modules) {
        if (!entry?.moduleName && !entry?.module_name) continue;
        await upsertEmployeeModuleAccess(pool, req.params.id, entry, {
          isActive,
          expiresAt,
          updatedBy: req.auth.userId,
        });
      }

      await writeAuditLog({
        userId: req.auth.userId,
        actionType: 'UPDATE',
        tableName: 'employee_access_controls',
        recordId: req.params.id,
        newValues: { modules: modules.map((m) => ({ module: m.moduleName || m.module_name, permissions: m.permissions })) },
      });

      res.json({ ok: true, updated: modules.length });
    } catch (err) {
      next(err);
    }
  },
);
