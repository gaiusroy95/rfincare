import { getPool, isDuplicateColumnError, isIgnorableMigrationError } from '../db/pool.js';
import { newId } from './ids.js';

const DEFAULT_TAT_MINUTES = 20;
const DEFAULT_AMBER_MINUTES = 15;
const DEFAULT_MAX_REASSIGNMENTS = 5;

let schemaReady = false;
let settingsSchemaReady = false;

/** Settings table only — must succeed even if marketing_leads alters fail. */
export async function ensureLeadAssignmentSettingsSchema(pool = getPool()) {
  if (settingsSchemaReady) return;
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS lead_assignment_settings (
        id VARCHAR(32) NOT NULL DEFAULT 'default',
        first_contact_tat_minutes INTEGER NOT NULL DEFAULT 20,
        round_robin_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        last_assigned_employee_id CHAR(36) NULL,
        amber_warning_minutes INTEGER NOT NULL DEFAULT 15,
        red_zone_minutes INTEGER NOT NULL DEFAULT 20,
        auto_reassign_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        max_reassignments INTEGER NOT NULL DEFAULT 5,
        notify_email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        notify_whatsapp_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
    `);
    await pool.execute(
      `INSERT INTO lead_assignment_settings (id) VALUES ('default') ON CONFLICT (id) DO NOTHING`,
    );

    const settingsAlters = [
      `ALTER TABLE lead_assignment_settings ADD COLUMN IF NOT EXISTS amber_warning_minutes INTEGER NOT NULL DEFAULT 15`,
      `ALTER TABLE lead_assignment_settings ADD COLUMN IF NOT EXISTS red_zone_minutes INTEGER NOT NULL DEFAULT 20`,
      `ALTER TABLE lead_assignment_settings ADD COLUMN IF NOT EXISTS auto_reassign_enabled BOOLEAN NOT NULL DEFAULT TRUE`,
      `ALTER TABLE lead_assignment_settings ADD COLUMN IF NOT EXISTS max_reassignments INTEGER NOT NULL DEFAULT 5`,
      `ALTER TABLE lead_assignment_settings ADD COLUMN IF NOT EXISTS notify_email_enabled BOOLEAN NOT NULL DEFAULT TRUE`,
      `ALTER TABLE lead_assignment_settings ADD COLUMN IF NOT EXISTS notify_whatsapp_enabled BOOLEAN NOT NULL DEFAULT TRUE`,
      `ALTER TABLE lead_assignment_settings ADD COLUMN IF NOT EXISTS last_assigned_employee_id CHAR(36) NULL`,
      `ALTER TABLE lead_assignment_settings ADD COLUMN IF NOT EXISTS round_robin_enabled BOOLEAN NOT NULL DEFAULT TRUE`,
      `ALTER TABLE lead_assignment_settings ADD COLUMN IF NOT EXISTS first_contact_tat_minutes INTEGER NOT NULL DEFAULT 20`,
    ];
    for (const sql of settingsAlters) {
      try {
        await pool.execute(sql);
      } catch (err) {
        if (!isDuplicateColumnError(err) && !isIgnorableMigrationError(err)) {
          console.warn('[lead-assignment-settings-alter]', err?.message || err);
        }
      }
    }
    settingsSchemaReady = true;
  } catch (err) {
    if (isIgnorableMigrationError(err)) {
      settingsSchemaReady = true;
      return;
    }
    throw err;
  }
}

export async function ensureLeadAssignmentSchema(pool = getPool()) {
  await ensureLeadAssignmentSettingsSchema(pool);
  if (schemaReady) return;
  try {
    const alters = [
      `ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ NULL`,
      `ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS first_contact_due_at TIMESTAMPTZ NULL`,
      `ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS first_contact_at TIMESTAMPTZ NULL`,
      `ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS first_contact_channel VARCHAR(32) NULL`,
      `ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS first_contact_by CHAR(36) NULL`,
      `ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS tat_minutes INTEGER NULL`,
      `ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS tat_status VARCHAR(32) NULL`,
      `ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS assignment_method VARCHAR(32) NULL`,
      `ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS red_zone BOOLEAN NOT NULL DEFAULT FALSE`,
      `ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS reassignment_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS previous_assigned_to CHAR(36) NULL`,
      `ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS contact_attempted_at TIMESTAMPTZ NULL`,
      `ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS contact_connected_at TIMESTAMPTZ NULL`,
      `ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS call_attempt_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS whatsapp_message_count INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS next_follow_up_at TIMESTAMPTZ NULL`,
      `ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS employee_remarks TEXT NULL`,
      `ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS loan_amount NUMERIC(14, 2) NULL`,
      `ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS employment_type VARCHAR(64) NULL`,
      `ALTER TABLE marketing_leads ADD COLUMN IF NOT EXISTS location_city VARCHAR(128) NULL`,
      `ALTER TABLE employee_onboarding ADD COLUMN IF NOT EXISTS lead_available BOOLEAN NOT NULL DEFAULT TRUE`,
      `ALTER TABLE employee_onboarding ADD COLUMN IF NOT EXISTS lead_level INTEGER NULL`,
      `ALTER TABLE employee_onboarding ADD COLUMN IF NOT EXISTS missed_lead_count INTEGER NOT NULL DEFAULT 0`,
    ];
    for (const sql of alters) {
      try {
        await pool.execute(sql);
      } catch (err) {
        if (!isDuplicateColumnError(err) && !isIgnorableMigrationError(err)) {
          // Best-effort — do not block TAT settings save if lead-column alters fail.
          console.warn('[lead-assignment-alter]', err?.message || err);
        }
      }
    }

    try {
      await pool.execute(`
        CREATE TABLE IF NOT EXISTS lead_activities (
          id CHAR(36) NOT NULL PRIMARY KEY,
          lead_id CHAR(36) NOT NULL,
          actor_user_id CHAR(36) NULL,
          activity_type VARCHAR(32) NOT NULL,
          channel VARCHAR(32) NULL,
          notes TEXT NULL,
          meta_json JSONB NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.execute(`
        CREATE TABLE IF NOT EXISTS lead_assignment_history (
          id CHAR(36) NOT NULL PRIMARY KEY,
          lead_id CHAR(36) NOT NULL,
          from_employee_id CHAR(36) NULL,
          to_employee_id CHAR(36) NULL,
          assignment_rule VARCHAR(64) NULL,
          queue_position INTEGER NULL,
          reason VARCHAR(64) NULL,
          tat_minutes INTEGER NULL,
          meta_json JSONB NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
    } catch (err) {
      console.warn('[lead-assignment-history]', err?.message || err);
    }
    schemaReady = true;
  } catch (err) {
    if (isIgnorableMigrationError(err)) {
      schemaReady = true;
      return;
    }
    // Settings schema is already ready — allow settings APIs to proceed.
    console.warn('[lead-assignment-schema]', err?.message || err);
    schemaReady = true;
  }
}

function boolSetting(value, fallback = true) {
  if (value === undefined || value === null) return fallback;
  return value !== false && value !== 0 && value !== '0' && value !== 'false';
}

export async function getLeadAssignmentSettings(pool = getPool()) {
  await ensureLeadAssignmentSettingsSchema(pool);
  await ensureLeadAssignmentSchema(pool).catch(() => {});
  const [[row]] = await pool.execute(
    `SELECT * FROM lead_assignment_settings WHERE id = 'default' LIMIT 1`,
  );
  const tat = Number(row?.first_contact_tat_minutes ?? DEFAULT_TAT_MINUTES);
  return {
    firstContactTatMinutes: tat,
    roundRobinEnabled: boolSetting(row?.round_robin_enabled, true),
    lastAssignedEmployeeId: row?.last_assigned_employee_id || null,
    amberWarningMinutes: Number(row?.amber_warning_minutes ?? DEFAULT_AMBER_MINUTES),
    redZoneMinutes: Number(row?.red_zone_minutes ?? tat),
    autoReassignEnabled: boolSetting(row?.auto_reassign_enabled, true),
    maxReassignments: Number(row?.max_reassignments ?? DEFAULT_MAX_REASSIGNMENTS),
    notifyEmailEnabled: boolSetting(row?.notify_email_enabled, true),
    notifyWhatsappEnabled: boolSetting(row?.notify_whatsapp_enabled, true),
  };
}

export async function updateLeadAssignmentSettings(pool, patch = {}) {
  await ensureLeadAssignmentSettingsSchema(pool);
  const current = await getLeadAssignmentSettings(pool);
  const tat = patch.firstContactTatMinutes != null
    ? Math.max(1, Math.min(240, Number(patch.firstContactTatMinutes) || DEFAULT_TAT_MINUTES))
    : current.firstContactTatMinutes;
  const amber = patch.amberWarningMinutes != null
    ? Math.max(1, Math.min(tat, Number(patch.amberWarningMinutes) || DEFAULT_AMBER_MINUTES))
    : Math.min(tat, current.amberWarningMinutes);
  const red = patch.redZoneMinutes != null
    ? Math.max(amber, Math.min(240, Number(patch.redZoneMinutes) || tat))
    : Math.max(amber, current.redZoneMinutes || tat);
  const enabled = patch.roundRobinEnabled != null
    ? Boolean(patch.roundRobinEnabled)
    : current.roundRobinEnabled;
  const autoReassign = patch.autoReassignEnabled != null
    ? Boolean(patch.autoReassignEnabled)
    : current.autoReassignEnabled;
  const maxReassign = patch.maxReassignments != null
    ? Math.max(0, Math.min(50, Number(patch.maxReassignments) || 0))
    : current.maxReassignments;
  const notifyEmail = patch.notifyEmailEnabled != null
    ? Boolean(patch.notifyEmailEnabled)
    : current.notifyEmailEnabled;
  const notifyWa = patch.notifyWhatsappEnabled != null
    ? Boolean(patch.notifyWhatsappEnabled)
    : current.notifyWhatsappEnabled;

  // Embed sanitized literals — avoids PG "could not determine data type of parameter"
  // when CAST(:name AS BOOLEAN/INTEGER) is used with unbound named params.
  const tatInt = Math.trunc(Number(tat)) || DEFAULT_TAT_MINUTES;
  const amberInt = Math.trunc(Number(amber)) || DEFAULT_AMBER_MINUTES;
  const redInt = Math.trunc(Number(red)) || tatInt;
  const maxReassignInt = Math.trunc(Number(maxReassign)) || 0;
  const enabledSql = enabled ? 'TRUE' : 'FALSE';
  const autoReassignSql = autoReassign ? 'TRUE' : 'FALSE';
  const notifyEmailSql = notifyEmail ? 'TRUE' : 'FALSE';
  const notifyWaSql = notifyWa ? 'TRUE' : 'FALSE';

  // UPSERT so save works even if the default row was never inserted.
  await pool.execute(
    `INSERT INTO lead_assignment_settings (
       id,
       first_contact_tat_minutes,
       round_robin_enabled,
       amber_warning_minutes,
       red_zone_minutes,
       auto_reassign_enabled,
       max_reassignments,
       notify_email_enabled,
       notify_whatsapp_enabled,
       updated_at
     ) VALUES (
       'default',
       ${tatInt},
       ${enabledSql},
       ${amberInt},
       ${redInt},
       ${autoReassignSql},
       ${maxReassignInt},
       ${notifyEmailSql},
       ${notifyWaSql},
       NOW()
     )
     ON CONFLICT (id) DO UPDATE SET
       first_contact_tat_minutes = EXCLUDED.first_contact_tat_minutes,
       round_robin_enabled = EXCLUDED.round_robin_enabled,
       amber_warning_minutes = EXCLUDED.amber_warning_minutes,
       red_zone_minutes = EXCLUDED.red_zone_minutes,
       auto_reassign_enabled = EXCLUDED.auto_reassign_enabled,
       max_reassignments = EXCLUDED.max_reassignments,
       notify_email_enabled = EXCLUDED.notify_email_enabled,
       notify_whatsapp_enabled = EXCLUDED.notify_whatsapp_enabled,
       updated_at = NOW()`,
  );
  return getLeadAssignmentSettings(pool);
}

/**
 * Live/available L1 employees for lead queue.
 * Skips absent/offline (lead_available = false), inactive, and non-L1.
 */
export async function listAvailableL1Employees(pool, { excludeIds = [] } = {}) {
  await ensureLeadAssignmentSchema(pool);
  const exclude = (excludeIds || []).filter(Boolean);

  const [l1Rows] = await pool.execute(
    `SELECT DISTINCT up.id, up.full_name, up.phone, eo.employee_code,
            NULLIF(TRIM(COALESCE(eo.email, up.email, '')), '') AS email,
            COALESCE(eo.lead_available, TRUE) AS lead_available,
            COALESCE(eo.lead_level, h.min_level, 1) AS lead_level
     FROM user_profiles up
     LEFT JOIN employee_onboarding eo ON eo.user_id = up.id
     LEFT JOIN (
       SELECT employee_user_id, MIN(hierarchy_level)::int AS min_level
       FROM agent_employee_hierarchy
       GROUP BY employee_user_id
     ) h ON h.employee_user_id = up.id
     WHERE up.role = 'employee'
       AND COALESCE(up.is_active, TRUE) = TRUE
       AND COALESCE(up.account_status, 'active') NOT IN ('suspended', 'inactive', 'terminated')
       AND COALESCE(eo.onboarding_status, 'active') NOT IN ('inactive', 'terminated', 'rejected', 'on_leave')
       AND COALESCE(eo.lead_available, TRUE) = TRUE
       AND (
         COALESCE(eo.lead_level, h.min_level, 1) = 1
         OR (eo.lead_level IS NULL AND h.min_level IS NULL)
       )
     ORDER BY eo.employee_code ASC NULLS LAST, up.created_at ASC`,
  ).catch(async () => {
    const [fallback] = await pool.execute(
      `SELECT up.id, up.full_name, up.phone, eo.employee_code,
              NULLIF(TRIM(COALESCE(eo.email, up.email, '')), '') AS email,
              TRUE AS lead_available, 1 AS lead_level
       FROM user_profiles up
       LEFT JOIN employee_onboarding eo ON eo.user_id = up.id
       WHERE up.role = 'employee'
         AND COALESCE(up.is_active, TRUE) = TRUE
         AND COALESCE(eo.lead_available, TRUE) = TRUE
       ORDER BY up.created_at ASC`,
    );
    return [fallback];
  });

  return (l1Rows || []).filter((r) => r?.id && !exclude.includes(r.id));
}

function pickRoundRobin(candidates, lastAssignedId) {
  if (!candidates.length) return null;
  if (!lastAssignedId) return candidates[0];
  const idx = candidates.findIndex((c) => c.id === lastAssignedId);
  if (idx < 0) return candidates[0];
  return candidates[(idx + 1) % candidates.length];
}

export function computeTatStatus({ firstContactAt, firstContactDueAt, now = new Date() } = {}) {
  if (firstContactAt) {
    const due = firstContactDueAt ? new Date(firstContactDueAt).getTime() : null;
    const contacted = new Date(firstContactAt).getTime();
    if (due != null && contacted > due) return 'breached_contacted';
    return 'met';
  }
  if (!firstContactDueAt) return 'pending';
  if (new Date(firstContactDueAt).getTime() < now.getTime()) return 'breached';
  return 'pending';
}

export function computeTatZone({
  firstContactAt,
  firstContactDueAt,
  assignedAt,
  amberWarningMinutes = DEFAULT_AMBER_MINUTES,
  redZoneMinutes = DEFAULT_TAT_MINUTES,
  now = new Date(),
} = {}) {
  if (firstContactAt) {
    const due = firstContactDueAt ? new Date(firstContactDueAt).getTime() : null;
    const contacted = new Date(firstContactAt).getTime();
    if (due != null && contacted > due) return 'red';
    return 'green';
  }
  if (!firstContactDueAt && !assignedAt) return null;
  const start = assignedAt ? new Date(assignedAt).getTime() : null;
  const due = firstContactDueAt
    ? new Date(firstContactDueAt).getTime()
    : start
      ? start + redZoneMinutes * 60 * 1000
      : null;
  if (due == null) return null;
  const elapsedMin = start != null ? (now.getTime() - start) / 60000 : null;
  if (now.getTime() >= due) return 'red';
  if (elapsedMin != null && elapsedMin >= amberWarningMinutes) return 'amber';
  // Also amber when remaining time is within (red - amber) window near due
  const remainingMin = (due - now.getTime()) / 60000;
  if (remainingMin <= Math.max(0, redZoneMinutes - amberWarningMinutes)) return 'amber';
  return 'green';
}

export function remainingTatSeconds(firstContactDueAt, firstContactAt, now = new Date()) {
  if (firstContactAt || !firstContactDueAt) return null;
  return Math.floor((new Date(firstContactDueAt).getTime() - now.getTime()) / 1000);
}

async function writeAssignmentHistory(pool, {
  leadId,
  fromEmployeeId = null,
  toEmployeeId = null,
  assignmentRule = 'round_robin_l1',
  queuePosition = null,
  reason = 'initial',
  tatMinutes = null,
  meta = null,
}) {
  const id = newId();
  await pool.execute(
    `INSERT INTO lead_assignment_history (
       id, lead_id, from_employee_id, to_employee_id, assignment_rule,
       queue_position, reason, tat_minutes, meta_json
     ) VALUES (
       CAST(:id AS CHAR(36)),
       CAST(:lead_id AS CHAR(36)),
       CAST(:from_id AS CHAR(36)),
       CAST(:to_id AS CHAR(36)),
       CAST(:rule AS TEXT),
       CAST(:pos AS INTEGER),
       CAST(:reason AS TEXT),
       CAST(:tat AS INTEGER),
       CAST(:meta AS JSONB)
     )`,
    {
      id,
      lead_id: leadId,
      from_id: fromEmployeeId || null,
      to_id: toEmployeeId || null,
      rule: assignmentRule,
      pos: queuePosition,
      reason,
      tat: tatMinutes,
      meta: meta ? JSON.stringify(meta) : null,
    },
  );
  return id;
}

function leadDeepLink(leadId) {
  const base = String(
    process.env.FRONTEND_ORIGIN
    || process.env.PUBLIC_FRONTEND_URL
    || process.env.APP_ORIGIN
    || '',
  ).replace(/\/$/, '');
  if (!base) return null;
  return `${base}/admin-dashboard?tab=leads&leadId=${encodeURIComponent(leadId)}`;
}

/**
 * Resolve the immediate next-level manager for an employee (by lead_level).
 * Prefers the lowest lead_level strictly greater than the assignee's level.
 */
export async function resolveImmediateManager(pool, employeeUserId) {
  if (!employeeUserId) return null;
  const [[self]] = await pool.execute(
    `SELECT up.id,
            COALESCE(eo.lead_level, h.min_level, 1)::int AS lead_level
     FROM user_profiles up
     LEFT JOIN employee_onboarding eo ON eo.user_id = up.id
     LEFT JOIN (
       SELECT employee_user_id, MIN(hierarchy_level)::int AS min_level
       FROM agent_employee_hierarchy
       GROUP BY employee_user_id
     ) h ON h.employee_user_id = up.id
     WHERE up.id = :id
     LIMIT 1`,
    { id: employeeUserId },
  ).catch(() => [[null]]);

  const selfLevel = Number(self?.lead_level || 1);

  const [managers] = await pool.execute(
    `SELECT up.id, up.full_name, up.phone,
            NULLIF(TRIM(COALESCE(eo.email, up.email, '')), '') AS email,
            COALESCE(eo.lead_level, h.min_level, 2)::int AS lead_level
     FROM user_profiles up
     LEFT JOIN employee_onboarding eo ON eo.user_id = up.id
     LEFT JOIN (
       SELECT employee_user_id, MIN(hierarchy_level)::int AS min_level
       FROM agent_employee_hierarchy
       GROUP BY employee_user_id
     ) h ON h.employee_user_id = up.id
     WHERE up.role = 'employee'
       AND up.id <> :id
       AND COALESCE(up.is_active, TRUE) = TRUE
       AND COALESCE(eo.lead_level, h.min_level, 0) > CAST(:level AS INTEGER)
     ORDER BY COALESCE(eo.lead_level, h.min_level, 99) ASC, eo.employee_code ASC NULLS LAST
     LIMIT 5`,
    { id: employeeUserId, level: selfLevel },
  ).catch(() => [[]]);

  if (managers?.length) return managers[0];

  // Fallback: any L2+ employee
  const [[fallback]] = await pool.execute(
    `SELECT up.id, up.full_name, up.phone,
            NULLIF(TRIM(COALESCE(eo.email, up.email, '')), '') AS email,
            COALESCE(eo.lead_level, 2)::int AS lead_level
     FROM user_profiles up
     LEFT JOIN employee_onboarding eo ON eo.user_id = up.id
     WHERE up.role = 'employee'
       AND up.id <> :id
       AND COALESCE(up.is_active, TRUE) = TRUE
       AND COALESCE(eo.lead_level, 0) >= 2
     ORDER BY eo.lead_level ASC, eo.employee_code ASC NULLS LAST
     LIMIT 1`,
    { id: employeeUserId },
  ).catch(() => [[null]]);

  return fallback || null;
}

/**
 * Notify assigned employee (TO) + immediate manager (CC) + in-app for L2/admin.
 * For TAT miss: email goes to the responsible assignee with manager in CC.
 */
export async function notifyLeadStakeholders(pool, {
  lead,
  assignee,
  eventType = 'lead_assigned',
  title,
  message,
}) {
  if (!lead?.id) return;
  const settings = await getLeadAssignmentSettings(pool);
  const link = leadDeepLink(lead.id);
  const fullMessage = link ? `${message}\n\nOpen lead: ${link}` : message;
  const isTatEvent = ['lead_tat_missed', 'lead_reassigned', 'lead_tat_warning'].includes(
    String(eventType || ''),
  );

  try {
    const { createStaffNotification } = await import('../routes/notifications.js');

    const [allEmployees] = await pool.execute(
      `SELECT up.id, up.full_name, up.role, up.phone,
              NULLIF(TRIM(COALESCE(eo.email, '')), '') AS official_email,
              NULLIF(TRIM(COALESCE(up.email, '')), '') AS profile_email,
              COALESCE(eo.lead_level, 0)::int AS lead_level
       FROM user_profiles up
       LEFT JOIN employee_onboarding eo ON eo.user_id = up.id
       WHERE up.role = 'employee'
         AND COALESCE(up.is_active, TRUE) = TRUE`,
    ).catch(() => [[]]);

    const withOfficialEmail = (row) => ({
      ...row,
      email: row?.official_email || row?.profile_email || row?.email || null,
    });

    const employees = (allEmployees || []).map(withOfficialEmail);

    let assigneeRow = null;
    if (assignee?.id) {
      assigneeRow = employees.find((e) => e.id === assignee.id) || withOfficialEmail({
        id: assignee.id,
        official_email: null,
        profile_email: assignee.email,
        phone: assignee.phone,
        full_name: assignee.full_name || assignee.fullName,
        role: 'employee',
        lead_level: assignee.lead_level || 1,
      });
      await createStaffNotification(pool, {
        userId: assigneeRow.id,
        role: 'employee',
        eventType,
        title,
        message: fullMessage,
        data: { leadId: lead.id, path: link },
      }).catch(() => {});
    }

    const manager = assigneeRow?.id
      ? await resolveImmediateManager(pool, assigneeRow.id)
      : null;
    const managerRow = manager ? withOfficialEmail(manager) : null;

    if (managerRow?.id) {
      await createStaffNotification(pool, {
        userId: managerRow.id,
        role: 'employee',
        eventType,
        title,
        message: fullMessage,
        data: { leadId: lead.id, path: link, escalatedFrom: assigneeRow?.id || null },
      }).catch(() => {});
    }

    // Broader in-app for other L2+ (visibility) excluding assignee/manager already notified.
    const supervisors = employees.filter(
      (e) =>
        Number(e.lead_level || 0) >= 2
        && e.id !== assigneeRow?.id
        && e.id !== managerRow?.id,
    );
    for (const sup of supervisors.slice(0, 10)) {
      await createStaffNotification(pool, {
        userId: sup.id,
        role: 'employee',
        eventType,
        title,
        message: fullMessage,
        data: { leadId: lead.id, path: link },
      }).catch(() => {});
    }

    const [admins] = await pool.execute(
      `SELECT id, email, phone, full_name, role FROM user_profiles
       WHERE role IN ('admin', 'super_admin')
         AND COALESCE(is_active, TRUE) = TRUE`,
    ).catch(() => [[]]);

    for (const admin of admins || []) {
      await createStaffNotification(pool, {
        userId: admin.id,
        role: admin.role,
        eventType,
        title,
        message: fullMessage,
        data: { leadId: lead.id, path: link },
      }).catch(() => {});
    }

    if (settings.notifyEmailEnabled) {
      const { sendEmail } = await import('./email.js');
      const toEmail =
        assigneeRow?.email
        || (assignee?.email ? String(assignee.email).trim() : null);
      const ccList = [];
      if (managerRow?.email && String(managerRow.email).toLowerCase() !== String(toEmail || '').toLowerCase()) {
        ccList.push(managerRow.email);
      }

      if (toEmail) {
        await sendEmail({
          to: toEmail,
          cc: ccList.length ? ccList : undefined,
          subject: title,
          text: fullMessage,
          html: `<p>${fullMessage.replace(/\n/g, '<br/>')}</p>`,
        }).catch(() => {});

        await recordLeadActivity(pool, {
          leadId: lead.id,
          activityType: isTatEvent ? 'tat_notification_sent' : 'assignment_notification_sent',
          channel: 'email',
          notes: `Email sent to ${toEmail}${ccList.length ? ` (CC: ${ccList.join(', ')})` : ''}`,
          meta: {
            eventType,
            to: toEmail,
            cc: ccList,
            assigneeId: assigneeRow?.id || null,
            managerId: managerRow?.id || null,
          },
        }).catch(() => {});
      } else if (isTatEvent && managerRow?.email) {
        // No assignee email — escalate directly to manager.
        await sendEmail({
          to: managerRow.email,
          subject: title,
          text: fullMessage,
          html: `<p>${fullMessage.replace(/\n/g, '<br/>')}</p>`,
        }).catch(() => {});
      }
    }

    if (settings.notifyWhatsappEnabled) {
      const waTargets = [];
      const seenPhones = new Set();
      const pushTarget = (row, role) => {
        const phone = String(row?.phone || '').replace(/\D/g, '').slice(-10);
        if (!phone || phone.length !== 10 || seenPhones.has(phone)) return;
        seenPhones.add(phone);
        waTargets.push({
          phone,
          role,
          userId: row?.id || null,
          name: row?.full_name || row?.fullName || role,
        });
      };
      pushTarget(assigneeRow || assignee, 'assignee');
      pushTarget(managerRow, 'manager');

      if (waTargets.length) {
        const {
          sendMsg91TransactionalSms,
          isMsg91Configured,
        } = await import('./msg91.js');
        // Free-text WhatsApp templates are not available for lead events; MSG91
        // transactional SMS is the reliable WhatsApp-notify fallback.
        const smsBody = String(fullMessage || message || title || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300);

        if (smsBody && isMsg91Configured()) {
          for (const target of waTargets) {
            try {
              await sendMsg91TransactionalSms({
                phone: target.phone,
                message: smsBody,
              });
              await recordLeadActivity(pool, {
                leadId: lead.id,
                activityType: isTatEvent ? 'tat_notification_sent' : 'assignment_notification_sent',
                channel: 'whatsapp',
                notes: `WhatsApp notify (SMS fallback) to ${target.role} ${target.phone}`,
                meta: {
                  eventType,
                  delivery: 'sms_fallback',
                  role: target.role,
                  phone: target.phone,
                  userId: target.userId,
                  assigneeId: assigneeRow?.id || null,
                  managerId: managerRow?.id || null,
                },
              }).catch(() => {});
            } catch (waErr) {
              console.warn('[lead-notify:whatsapp]', target.phone, waErr?.message || waErr);
            }
          }
        } else if (smsBody) {
          for (const target of waTargets) {
            console.log('[lead-notify:whatsapp:console]', target.role, target.phone, smsBody.slice(0, 120));
          }
        }
      }
    }
  } catch (err) {
    console.warn('[lead-notify]', err?.message || err);
  }
}

async function assignToEmployee(pool, {
  leadId,
  lead,
  employee,
  settings,
  reason = 'initial',
  fromEmployeeId = null,
  method = 'round_robin_l1',
  queuePosition = null,
}) {
  const tatMinutes = settings.firstContactTatMinutes || DEFAULT_TAT_MINUTES;
  const reassignmentBump = reason === 'tat_miss' ? 1 : 0;

  await pool.execute(
    `UPDATE marketing_leads SET
       previous_assigned_to = CASE
         WHEN CAST(:from_id AS TEXT) IS NOT NULL AND CAST(:from_id AS TEXT) <> ''
         THEN CAST(:from_id AS CHAR(36))
         ELSE previous_assigned_to
       END,
       assigned_to = CAST(:assignee AS CHAR(36)),
       assigned_at = NOW(),
       assignment_method = :method,
       status = CASE
         WHEN status IN ('new', 'verified', 'draft_started') THEN 'assigned'
         ELSE status
       END,
       tat_minutes = CAST(:tat_minutes AS INTEGER),
       first_contact_due_at = NOW() + (CAST(:tat_minutes AS INTEGER) * INTERVAL '1 minute'),
       first_contact_at = NULL,
       first_contact_channel = NULL,
       first_contact_by = NULL,
       tat_status = 'pending',
       red_zone = CASE WHEN :reason = 'tat_miss' THEN TRUE ELSE COALESCE(red_zone, FALSE) END,
       reassignment_count = COALESCE(reassignment_count, 0) + CAST(:bump AS INTEGER),
       updated_at = NOW()
     WHERE id = CAST(:id AS CHAR(36))`,
    {
      id: leadId,
      assignee: employee.id,
      from_id: fromEmployeeId || null,
      method,
      tat_minutes: tatMinutes,
      reason,
      bump: reassignmentBump,
    },
  );

  await pool.execute(
    `UPDATE lead_assignment_settings SET
       last_assigned_employee_id = CAST(:assignee AS CHAR(36)),
       updated_at = NOW()
     WHERE id = 'default'`,
    { assignee: employee.id },
  );

  await writeAssignmentHistory(pool, {
    leadId,
    fromEmployeeId,
    toEmployeeId: employee.id,
    assignmentRule: method,
    queuePosition,
    reason,
    tatMinutes,
    meta: {
      employeeCode: employee.employee_code || null,
      employeeName: employee.full_name || null,
    },
  });

  await recordLeadActivity(pool, {
    leadId,
    actorUserId: null,
    activityType: reason === 'tat_miss' ? 'reassigned' : 'assigned',
    channel: 'system',
    notes:
      reason === 'tat_miss'
        ? `TAT missed — reassigned to L1 ${employee.employee_code || employee.full_name || employee.id}`
        : `Auto-assigned to L1 ${employee.employee_code || employee.full_name || employee.id} (round-robin)`,
    meta: {
      assigneeId: employee.id,
      method,
      tatMinutes,
      reason,
      fromEmployeeId,
    },
  });

  const [[fresh]] = await pool.execute(
    `SELECT * FROM marketing_leads WHERE id = :id`,
    { id: leadId },
  );

  await notifyLeadStakeholders(pool, {
    lead: fresh || lead,
    assignee: employee,
    eventType: reason === 'tat_miss' ? 'lead_reassigned' : 'lead_assigned',
    title:
      reason === 'tat_miss'
        ? `🔴 TAT MISSED — Lead reassigned`
        : `New lead assigned`,
    message:
      reason === 'tat_miss'
        ? `Lead ${lead?.full_name || leadId} was reassigned to ${employee.full_name || employee.employee_code || 'you'} after a missed ${tatMinutes}-minute TAT. Fresh TAT started.`
        : `Lead ${lead?.full_name || leadId} (${lead?.phone || 'no phone'}) assigned to you. First contact within ${tatMinutes} minutes.`,
  });

  return fresh;
}

/**
 * Assign unassigned lead via fair round-robin to available L1; stamp TAT clock.
 */
export async function autoAssignLeadRoundRobin(pool, leadId, { force = false } = {}) {
  if (!leadId) return null;
  await ensureLeadAssignmentSchema(pool);
  const settings = await getLeadAssignmentSettings(pool);
  if (!settings.roundRobinEnabled && !force) return null;

  const [[lead]] = await pool.execute(
    `SELECT * FROM marketing_leads WHERE id = :id LIMIT 1`,
    { id: leadId },
  );
  if (!lead) return null;
  if (lead.assigned_to && !force) return lead;

  const candidates = await listAvailableL1Employees(pool);
  const next = pickRoundRobin(candidates, settings.lastAssignedEmployeeId);
  if (!next?.id) return lead;

  const queuePosition = Math.max(0, candidates.findIndex((c) => c.id === next.id));
  return assignToEmployee(pool, {
    leadId,
    lead,
    employee: next,
    settings,
    reason: 'initial',
    fromEmployeeId: null,
    method: 'round_robin_l1',
    queuePosition,
  });
}

/**
 * Best-effort: assign a backlog of unassigned leads via round-robin (e.g. after TAT settings save).
 */
export async function assignUnassignedLeadsBacklog(pool, { limit = 50 } = {}) {
  await ensureLeadAssignmentSchema(pool);
  const settings = await getLeadAssignmentSettings(pool);
  if (!settings.roundRobinEnabled) {
    return { scanned: 0, assigned: 0, skipped: true };
  }
  const cap = Math.max(1, Math.min(200, Number(limit) || 50));
  const [rows] = await pool.execute(
    `SELECT id FROM marketing_leads
     WHERE assigned_to IS NULL
     ORDER BY created_at ASC NULLS LAST
     LIMIT ${cap}`,
  ).catch(() => [[]]);

  let assigned = 0;
  for (const row of rows || []) {
    try {
      const result = await autoAssignLeadRoundRobin(pool, row.id);
      if (result?.assigned_to) assigned += 1;
    } catch (err) {
      console.warn('[lead-assign:backlog]', row?.id, err?.message || err);
    }
  }
  return { scanned: (rows || []).length, assigned, skipped: false };
}

/**
 * When a lead is manually assigned, still start TAT if not already started.
 */
export async function ensureLeadTatClock(pool, leadId) {
  await ensureLeadAssignmentSchema(pool);
  const settings = await getLeadAssignmentSettings(pool);
  const tatMinutes = settings.firstContactTatMinutes || DEFAULT_TAT_MINUTES;
  await pool.execute(
    `UPDATE marketing_leads SET
       assigned_at = COALESCE(assigned_at, NOW()),
       tat_minutes = COALESCE(tat_minutes, CAST(:tat_minutes AS INTEGER)),
       first_contact_due_at = COALESCE(
         first_contact_due_at,
         COALESCE(assigned_at, NOW()) + (CAST(:tat_minutes AS INTEGER) * INTERVAL '1 minute')
       ),
       tat_status = COALESCE(tat_status, 'pending'),
       updated_at = NOW()
     WHERE id = CAST(:id AS CHAR(36))
       AND first_contact_at IS NULL`,
    { id: leadId, tat_minutes: tatMinutes },
  );
}

export async function recordLeadActivity(pool, {
  leadId,
  actorUserId = null,
  activityType,
  channel = null,
  notes = null,
  meta = null,
}) {
  await ensureLeadAssignmentSchema(pool);
  const id = newId();
  await pool.execute(
    `INSERT INTO lead_activities (
       id, lead_id, actor_user_id, activity_type, channel, notes, meta_json
     ) VALUES (
       CAST(:id AS CHAR(36)),
       CAST(:lead_id AS CHAR(36)),
       CAST(:actor_user_id AS CHAR(36)),
       CAST(:activity_type AS TEXT),
       CAST(:channel AS TEXT),
       CAST(:notes AS TEXT),
       CAST(:meta_json AS JSONB)
     )`,
    {
      id,
      lead_id: leadId,
      actor_user_id: actorUserId || null,
      activity_type: activityType,
      channel: channel || null,
      notes: notes || null,
      meta_json: meta ? JSON.stringify(meta) : null,
    },
  );
  return id;
}

/**
 * Log Call / WhatsApp / Email contact.
 * outcome: 'attempted' | 'connected' (default attempted for call/whatsapp click)
 * First contact TAT completes on any contact action (attempt); connected is tracked separately.
 */
export async function recordLeadContact(pool, {
  leadId,
  actorUserId,
  channel,
  notes = null,
  outcome = 'attempted',
  templateUsed = null,
}) {
  await ensureLeadAssignmentSchema(pool);
  const normalized = String(channel || '').toLowerCase();
  if (!['call', 'whatsapp', 'email'].includes(normalized)) {
    const err = new Error('channel must be call, whatsapp, or email');
    err.status = 400;
    throw err;
  }
  const contactOutcome = String(outcome || 'attempted').toLowerCase() === 'connected'
    ? 'connected'
    : 'attempted';

  const [[lead]] = await pool.execute(
    `SELECT * FROM marketing_leads WHERE id = :id LIMIT 1`,
    { id: leadId },
  );
  if (!lead) {
    const err = new Error('Lead not found');
    err.status = 404;
    throw err;
  }

  const isFirst = !lead.first_contact_at;
  let tatStatus = lead.tat_status;
  if (isFirst) {
    const due = lead.first_contact_due_at;
    const now = new Date();
    tatStatus = due && now.getTime() > new Date(due).getTime() ? 'breached_contacted' : 'met';
  }

  await pool.execute(
    `UPDATE marketing_leads SET
       contact_attempted_at = COALESCE(contact_attempted_at, NOW()),
       contact_connected_at = CASE
         WHEN :outcome = 'connected' THEN COALESCE(contact_connected_at, NOW())
         ELSE contact_connected_at
       END,
       call_attempt_count = call_attempt_count + CASE WHEN :channel = 'call' THEN 1 ELSE 0 END,
       whatsapp_message_count = whatsapp_message_count + CASE WHEN :channel = 'whatsapp' THEN 1 ELSE 0 END,
       first_contact_at = COALESCE(first_contact_at, NOW()),
       first_contact_channel = COALESCE(first_contact_channel, :channel),
       first_contact_by = COALESCE(first_contact_by, CAST(:actor AS CHAR(36))),
       tat_status = CASE
         WHEN first_contact_at IS NULL THEN CAST(:tat_status AS TEXT)
         ELSE tat_status
       END,
       red_zone = CASE
         WHEN first_contact_at IS NULL AND CAST(:tat_status AS TEXT) = 'met' THEN FALSE
         ELSE red_zone
       END,
       status = CASE
         WHEN status IN ('new', 'verified', 'draft_started', 'assigned', 'application_in_progress') THEN 'contacted'
         WHEN status = 'contacted' AND :outcome = 'connected' THEN 'interested'
         WHEN status IN ('contacted', 'interested') THEN 'in_progress'
         ELSE status
       END,
       updated_at = NOW()
     WHERE id = :id`,
    {
      id: leadId,
      channel: normalized,
      actor: actorUserId || null,
      tat_status: tatStatus,
      outcome: contactOutcome,
    },
  );

  await recordLeadActivity(pool, {
    leadId,
    actorUserId,
    activityType: isFirst ? 'first_contact' : 'contact',
    channel: normalized,
    notes:
      notes
      || (normalized === 'call'
        ? `Call ${contactOutcome}`
        : normalized === 'whatsapp'
          ? `WhatsApp ${contactOutcome}`
          : `Email ${contactOutcome}`),
    meta: {
      isFirst,
      tatStatus,
      outcome: contactOutcome,
      templateUsed: templateUsed || null,
    },
  });

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
    { id: leadId },
  );
  return fresh;
}

export async function listLeadActivities(pool, leadId, { limit = 50 } = {}) {
  await ensureLeadAssignmentSchema(pool);
  const [rows] = await pool.execute(
    `SELECT la.*, up.full_name AS actor_name, up.role AS actor_role
     FROM lead_activities la
     LEFT JOIN user_profiles up ON up.id = la.actor_user_id
     WHERE la.lead_id = :lead_id
     ORDER BY la.created_at DESC
     LIMIT CAST(:limit AS INTEGER)`,
    { lead_id: leadId, limit: Math.min(Number(limit) || 50, 200) },
  );
  return rows || [];
}

/**
 * Mark overdue pending TATs as breached / red zone (no reassignment yet).
 */
export async function refreshOverdueTatStatuses(pool) {
  await ensureLeadAssignmentSchema(pool);
  await pool.execute(
    `UPDATE marketing_leads SET
       tat_status = 'breached',
       red_zone = TRUE,
       updated_at = NOW()
     WHERE first_contact_at IS NULL
       AND first_contact_due_at IS NOT NULL
       AND first_contact_due_at < NOW()
       AND COALESCE(tat_status, 'pending') IN ('pending', 'breached')`,
  );
}

/**
 * Auto-reassign leads that missed first-contact TAT to next live L1.
 */
export async function processTatMissReassignments(pool, { limit = 50 } = {}) {
  await ensureLeadAssignmentSchema(pool);
  const settings = await getLeadAssignmentSettings(pool);
  await refreshOverdueTatStatuses(pool);

  const [overdue] = await pool.execute(
    `SELECT * FROM marketing_leads
     WHERE first_contact_at IS NULL
       AND assigned_to IS NOT NULL
       AND first_contact_due_at IS NOT NULL
       AND first_contact_due_at < NOW()
       AND COALESCE(tat_status, 'breached') IN ('pending', 'breached')
     ORDER BY first_contact_due_at ASC
     LIMIT CAST(:limit AS INTEGER)`,
    { limit: Math.min(Number(limit) || 50, 200) },
  );

  let reassigned = 0;
  let capped = 0;
  let skipped = 0;
  let notified = 0;

  for (const lead of overdue || []) {
    // Avoid duplicate breach notifications within a short window.
    const [[recentNotify]] = await pool.execute(
      `SELECT id FROM lead_activities
       WHERE lead_id = :lead_id
         AND activity_type IN ('tat_missed', 'tat_notification_sent')
         AND created_at > NOW() - INTERVAL '30 minutes'
       LIMIT 1`,
      { lead_id: lead.id },
    ).catch(() => [[null]]);

    const count = Number(lead.reassignment_count || 0);
    const atCap = count >= settings.maxReassignments;

    if (atCap && recentNotify) {
      capped += 1;
      continue;
    }

    if (atCap) {
      capped += 1;
      await recordLeadActivity(pool, {
        leadId: lead.id,
        activityType: 'tat_miss_capped',
        channel: 'system',
        notes: `TAT missed but max reassignments (${settings.maxReassignments}) reached — lead stays in Red Zone`,
        meta: { assignedTo: lead.assigned_to, reassignmentCount: count },
      }).catch(() => {});
    }

    const previousId = lead.assigned_to;
    let previousAssignee = null;
    if (previousId) {
      const [[prev]] = await pool.execute(
        `SELECT up.id, up.full_name, up.phone,
                NULLIF(TRIM(COALESCE(eo.email, up.email, '')), '') AS email,
                COALESCE(eo.lead_level, 1)::int AS lead_level
         FROM user_profiles up
         LEFT JOIN employee_onboarding eo ON eo.user_id = up.id
         WHERE up.id = :id
         LIMIT 1`,
        { id: previousId },
      ).catch(() => [[null]]);
      previousAssignee = prev || { id: previousId };

      if (!recentNotify) {
        await pool.execute(
          `UPDATE employee_onboarding SET
             missed_lead_count = COALESCE(missed_lead_count, 0) + 1
           WHERE user_id = :id`,
          { id: previousId },
        ).catch(() => {});
      }
    }

    if (!recentNotify) {
      await recordLeadActivity(pool, {
        leadId: lead.id,
        activityType: 'tat_missed',
        channel: 'system',
        notes: `TAT breached at ${new Date().toISOString()} — due was ${lead.first_contact_due_at || 'n/a'}`,
        meta: {
          previousAssignee: previousId,
          dueAt: lead.first_contact_due_at,
          assignedAt: lead.assigned_at,
          amberWarningMinutes: settings.amberWarningMinutes,
          tatMinutes: settings.firstContactTatMinutes,
          breachedAt: new Date().toISOString(),
        },
      });

      await notifyLeadStakeholders(pool, {
        lead,
        assignee: previousAssignee,
        eventType: 'lead_tat_missed',
        title: `TAT missed — ${lead.full_name || lead.id}`,
        message:
          `Lead ${lead.full_name || lead.id} missed the ${settings.firstContactTatMinutes}-minute first-contact TAT`
          + (previousAssignee?.full_name ? ` assigned to ${previousAssignee.full_name}.` : '.')
          + (settings.autoReassignEnabled && !atCap
            ? ' Auto-reassignment is in progress.'
            : ' Please contact the customer immediately.'),
      }).catch(() => {});
      notified += 1;
    }

    if (!settings.autoReassignEnabled || atCap) {
      skipped += 1;
      continue;
    }

    const candidates = await listAvailableL1Employees(pool, {
      excludeIds: [previousId].filter(Boolean),
    });
    const next = pickRoundRobin(candidates, settings.lastAssignedEmployeeId);
    if (!next?.id) {
      skipped += 1;
      continue;
    }

    const queuePosition = Math.max(0, candidates.findIndex((c) => c.id === next.id));
    await assignToEmployee(pool, {
      leadId: lead.id,
      lead,
      employee: next,
      settings,
      reason: 'tat_miss',
      fromEmployeeId: previousId,
      method: 'round_robin_tat_reassign',
      queuePosition,
    });
    reassigned += 1;
  }

  return {
    processed: (overdue || []).length,
    reassigned,
    capped,
    skipped,
    notified,
  };
}

/**
 * Resolve whether an employee can see all leads (L2/L3) or only assigned (L1).
 */
export async function resolveEmployeeLeadScope(pool, userId) {
  await ensureLeadAssignmentSchema(pool);
  const [[eo]] = await pool.execute(
    `SELECT lead_level FROM employee_onboarding WHERE user_id = :id LIMIT 1`,
    { id: userId },
  ).catch(() => [[null]]);
  if (eo?.lead_level != null && Number(eo.lead_level) >= 2) {
    return { scope: 'team', leadLevel: Number(eo.lead_level) };
  }

  const [[h]] = await pool.execute(
    `SELECT MIN(hierarchy_level)::int AS min_level, MAX(hierarchy_level)::int AS max_level
     FROM agent_employee_hierarchy
     WHERE employee_user_id = :id`,
    { id: userId },
  ).catch(() => [[null]]);

  const maxLevel = Number(h?.max_level || 1);
  const minLevel = Number(h?.min_level || 1);
  if (minLevel >= 2 || maxLevel >= 2) {
    return { scope: 'team', leadLevel: maxLevel };
  }
  return { scope: 'assigned', leadLevel: 1 };
}

export function enrichLeadTatFields(row, settings = null) {
  if (!row) return row;
  const firstContactAt = row.first_contact_at || null;
  const firstContactDueAt = row.first_contact_due_at || null;
  const assignedAt = row.assigned_at || null;
  const tatStatus = computeTatStatus({ firstContactAt, firstContactDueAt }) || row.tat_status || null;
  const amber = settings?.amberWarningMinutes ?? DEFAULT_AMBER_MINUTES;
  const red = settings?.redZoneMinutes ?? settings?.firstContactTatMinutes ?? DEFAULT_TAT_MINUTES;
  const tatZone = computeTatZone({
    firstContactAt,
    firstContactDueAt,
    assignedAt,
    amberWarningMinutes: amber,
    redZoneMinutes: red,
  });
  return {
    ...row,
    assignedAt,
    firstContactAt,
    firstContactDueAt,
    firstContactChannel: row.first_contact_channel || null,
    firstContactBy: row.first_contact_by || null,
    tatMinutes: row.tat_minutes != null ? Number(row.tat_minutes) : null,
    tatStatus,
    tatZone,
    tatRemainingSeconds: remainingTatSeconds(firstContactDueAt, firstContactAt),
    assignmentMethod: row.assignment_method || null,
    redZone: Boolean(row.red_zone),
    reassignmentCount: Number(row.reassignment_count || 0),
    previousAssignedTo: row.previous_assigned_to || null,
    contactAttemptedAt: row.contact_attempted_at || null,
    contactConnectedAt: row.contact_connected_at || null,
    callAttemptCount: Number(row.call_attempt_count || 0),
    whatsappMessageCount: Number(row.whatsapp_message_count || 0),
    nextFollowUpAt: row.next_follow_up_at || null,
    employeeRemarks: row.employee_remarks || null,
    loanAmount: row.loan_amount != null ? Number(row.loan_amount) : null,
    employmentType: row.employment_type || null,
    locationCity: row.location_city || null,
  };
}

export async function listRedZoneLeads(pool, { limit = 100 } = {}) {
  await ensureLeadAssignmentSchema(pool);
  await refreshOverdueTatStatuses(pool);
  const [rows] = await pool.execute(
    `SELECT ml.*,
            up.full_name AS assignee_name,
            up.role AS assignee_role,
            eo.employee_code AS assignee_code,
            prev.full_name AS previous_assignee_name,
            peo.employee_code AS previous_assignee_code
     FROM marketing_leads ml
     LEFT JOIN user_profiles up ON up.id = ml.assigned_to
     LEFT JOIN employee_onboarding eo ON eo.user_id = up.id
     LEFT JOIN user_profiles prev ON prev.id = ml.previous_assigned_to
     LEFT JOIN employee_onboarding peo ON peo.user_id = prev.id
     WHERE ml.red_zone = TRUE
        OR (
          ml.first_contact_at IS NULL
          AND ml.first_contact_due_at IS NOT NULL
          AND ml.first_contact_due_at < NOW()
        )
     ORDER BY ml.first_contact_due_at ASC NULLS LAST
     LIMIT CAST(:limit AS INTEGER)`,
    { limit: Math.min(Number(limit) || 100, 500) },
  );
  const settings = await getLeadAssignmentSettings(pool);
  return (rows || []).map((r) => enrichLeadTatFields(r, settings));
}

export async function getLeadPerformanceReport(pool) {
  await ensureLeadAssignmentSchema(pool);
  const [rows] = await pool.execute(
    `SELECT
       up.id AS employee_id,
       up.full_name,
       eo.employee_code,
       COALESCE(eo.missed_lead_count, 0) AS missed_lead_count,
       COUNT(ml.id)::int AS assigned,
       COUNT(ml.id) FILTER (WHERE ml.first_contact_at IS NOT NULL)::int AS contacted,
       COUNT(ml.id) FILTER (
         WHERE ml.first_contact_at IS NOT NULL
           AND ml.first_contact_due_at IS NOT NULL
           AND ml.first_contact_at <= ml.first_contact_due_at
       )::int AS within_tat,
       COUNT(ml.id) FILTER (
         WHERE ml.tat_status IN ('breached', 'breached_contacted')
            OR (ml.first_contact_at IS NULL AND ml.first_contact_due_at < NOW())
       )::int AS tat_missed,
       COUNT(ml.id) FILTER (WHERE COALESCE(ml.reassignment_count, 0) > 0)::int AS reassigned,
       COUNT(ml.id) FILTER (
         WHERE LOWER(COALESCE(ml.status, '')) IN ('converted', 'approved', 'disbursed')
       )::int AS converted,
       COALESCE(SUM(ml.call_attempt_count), 0)::int AS call_attempts,
       COALESCE(SUM(ml.whatsapp_message_count), 0)::int AS whatsapp_messages,
       AVG(
         EXTRACT(EPOCH FROM (ml.first_contact_at - ml.assigned_at))
       ) FILTER (WHERE ml.first_contact_at IS NOT NULL AND ml.assigned_at IS NOT NULL) AS avg_first_response_seconds
     FROM user_profiles up
     LEFT JOIN employee_onboarding eo ON eo.user_id = up.id
     LEFT JOIN marketing_leads ml ON ml.assigned_to = up.id
     WHERE up.role = 'employee'
       AND COALESCE(up.is_active, TRUE) = TRUE
     GROUP BY up.id, up.full_name, eo.employee_code, eo.missed_lead_count
     HAVING COUNT(ml.id) > 0 OR COALESCE(eo.missed_lead_count, 0) > 0
     ORDER BY assigned DESC, up.full_name ASC`,
  ).catch(() => [[]]);

  const [[kpis]] = await pool.execute(
    `SELECT
       COUNT(*)::int AS total_leads,
       COUNT(*) FILTER (WHERE assigned_to IS NOT NULL AND first_contact_at IS NULL)::int AS live_leads,
       COUNT(*) FILTER (WHERE red_zone = TRUE)::int AS red_zone_leads,
       COUNT(*) FILTER (
         WHERE tat_status IN ('breached', 'breached_contacted')
            OR (first_contact_at IS NULL AND first_contact_due_at < NOW())
       )::int AS missed_tat_leads,
       COUNT(*) FILTER (WHERE COALESCE(reassignment_count, 0) > 0)::int AS auto_reassigned_leads,
       COALESCE(SUM(call_attempt_count), 0)::int AS call_attempts,
       COALESCE(SUM(whatsapp_message_count), 0)::int AS whatsapp_messages
     FROM marketing_leads`,
  ).catch(() => [[null]]);

  return {
    employees: (rows || []).map((r) => ({
      employeeId: r.employee_id,
      fullName: r.full_name,
      employeeCode: r.employee_code,
      missedLeadCount: Number(r.missed_lead_count || 0),
      assigned: Number(r.assigned || 0),
      contacted: Number(r.contacted || 0),
      withinTat: Number(r.within_tat || 0),
      tatMissed: Number(r.tat_missed || 0),
      reassigned: Number(r.reassigned || 0),
      converted: Number(r.converted || 0),
      callAttempts: Number(r.call_attempts || 0),
      whatsappMessages: Number(r.whatsapp_messages || 0),
      avgFirstResponseSeconds:
        r.avg_first_response_seconds != null ? Number(r.avg_first_response_seconds) : null,
      contactRate: r.assigned ? Number(r.contacted || 0) / Number(r.assigned) : 0,
      conversionRate: r.assigned ? Number(r.converted || 0) / Number(r.assigned) : 0,
    })),
    kpis: {
      totalLeads: Number(kpis?.total_leads || 0),
      liveLeads: Number(kpis?.live_leads || 0),
      redZoneLeads: Number(kpis?.red_zone_leads || 0),
      missedTatLeads: Number(kpis?.missed_tat_leads || 0),
      autoReassignedLeads: Number(kpis?.auto_reassigned_leads || 0),
      callAttempts: Number(kpis?.call_attempts || 0),
      whatsappMessages: Number(kpis?.whatsapp_messages || 0),
    },
  };
}
