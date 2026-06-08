import { getPool } from '../db/pool.js';
import { ensureStaffExtrasSchema } from '../db/ensureStaffExtrasSchema.js';

export const EMPLOYEE_ACCESS_MODULES = [
  { key: 'applications', label: 'Loan Applications' },
  { key: 'customers', label: 'Customer Management' },
  { key: 'agents', label: 'Agent Management' },
  { key: 'banks', label: 'Bank Management' },
  { key: 'reports', label: 'Reports & Analytics' },
  { key: 'documents', label: 'Document Management' },
  { key: 'approval_matrix', label: 'Approval Matrix' },
  { key: 'system_config', label: 'System Configuration' },
];

const MODULE_LABELS = Object.fromEntries(
  EMPLOYEE_ACCESS_MODULES.map((m) => [m.key, m.label]),
);

function parsePermissions(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function formatRow(row) {
  return {
    moduleName: row.module_name,
    permissions: parsePermissions(row.permissions_json),
    isActive: Boolean(row.is_active),
    expiresAt: row.expires_at,
  };
}

export async function fetchEmployeeAccessControls(employeeUserId) {
  if (!employeeUserId) return [];
  await ensureStaffExtrasSchema();
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT * FROM employee_access_controls WHERE employee_user_id = :id`,
    { id: employeeUserId },
  );
  return rows.map(formatRow);
}

export async function fetchEmployeeAccessControlsMap(employeeUserIds = []) {
  const ids = [...new Set(employeeUserIds.filter(Boolean))];
  if (!ids.length) return {};
  await ensureStaffExtrasSchema();
  const pool = getPool();
  const placeholders = ids.map((_, i) => `:id${i}`).join(',');
  const params = Object.fromEntries(ids.map((id, i) => [`id${i}`, id]));
  const [rows] = await pool.execute(
    `SELECT * FROM employee_access_controls WHERE employee_user_id IN (${placeholders})`,
    params,
  );
  return rows.reduce((acc, row) => {
    const userId = row.employee_user_id;
    if (!acc[userId]) acc[userId] = [];
    acc[userId].push(formatRow(row));
    return acc;
  }, {});
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() < Date.now();
}

/**
 * Build effective access for an employee.
 * If no rows exist, returns null (use default employee role permissions).
 */
export function buildEffectiveEmployeeAccess(rows = []) {
  if (!rows.length) return null;

  const expiresAt = rows.find((r) => r.expiresAt)?.expiresAt || null;
  if (isExpired(expiresAt)) {
    return {
      configured: true,
      isActive: false,
      expired: true,
      expiresAt,
      modules: {},
      grantedModuleLabels: [],
    };
  }

  const modules = {};
  let anyActive = false;
  for (const row of rows) {
    if (!row.isActive || !row.permissions?.length) continue;
    anyActive = true;
    modules[row.moduleName] = [...new Set(row.permissions)];
  }

  const grantedModuleLabels = Object.keys(modules)
    .map((key) => MODULE_LABELS[key] || key)
    .filter(Boolean);

  return {
    configured: true,
    isActive: anyActive,
    expired: false,
    expiresAt,
    modules,
    grantedModuleLabels,
  };
}

export async function getEffectiveEmployeeAccess(employeeUserId) {
  const rows = await fetchEmployeeAccessControls(employeeUserId);
  return buildEffectiveEmployeeAccess(rows);
}

export function employeeHasModulePermission(access, moduleName, permission = 'read') {
  if (!access) return true;
  if (access.expired || access.isActive === false) return false;
  const perms = access.modules?.[moduleName];
  if (!perms?.length) return false;
  if (perms.includes(permission)) return true;
  if (permission === 'read' && perms.includes('write')) return true;
  return false;
}

export function requireEmployeeModuleAccess(access, moduleName, permission = 'read') {
  if (!access) return;
  if (!employeeHasModulePermission(access, moduleName, permission)) {
    const label = MODULE_LABELS[moduleName] || moduleName;
    const e = new Error(`You do not have ${permission} access for ${label}`);
    e.status = 403;
    throw e;
  }
}

/** Enforce module access for employee role; admins bypass. Returns effective access or null. */
export async function assertEmployeeAccess(req, moduleName, permission = 'read') {
  if (req.auth?.role !== 'employee') return null;
  const access = await getEffectiveEmployeeAccess(req.auth.userId);
  requireEmployeeModuleAccess(access, moduleName, permission);
  return access;
}
