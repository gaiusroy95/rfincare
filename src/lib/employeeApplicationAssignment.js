import { newId } from './ids.js';

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function normalizeAgentCode(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Stage → hierarchy priority (1 = document verification, 2 = bank processing, 3 = closing).
 */
export function stagePriorityOrder(app) {
  const status = String(app?.status || '').toLowerCase();
  const docStage = String(app?.document_stage_status || '').toLowerCase();
  const bankStage = String(app?.bank_approval_status || '').toLowerCase();
  if (['documents_pending', 'pending', 'uploaded', 'in_review'].includes(docStage)) return 1;
  if (['submitted_to_bank', 'under_review', 'bank_review'].includes(bankStage)) return 2;
  if (['approved', 'rejected', 'completed', 'disbursed'].includes(status)) return 3;
  if (['submitted', 'pending', 'under_review', 'draft'].includes(status)) return 1;
  return 2;
}

export function resolveResponsibleEmployeeIdForStage(app, hierarchyRows = []) {
  if (!hierarchyRows.length) return app.assigned_employee_id || null;
  const sorted = [...hierarchyRows].sort((a, b) => {
    const la = Number(a.hierarchy_level || 999);
    const lb = Number(b.hierarchy_level || 999);
    if (la !== lb) return la - lb;
    if (Boolean(a.is_primary) !== Boolean(b.is_primary)) return a.is_primary ? -1 : 1;
    return String(a.employee_user_id || '').localeCompare(String(b.employee_user_id || ''));
  });
  const idx = Math.max(0, Math.min(sorted.length - 1, stagePriorityOrder(app) - 1));
  return sorted[idx]?.employee_user_id || app.assigned_employee_id || null;
}

async function loadActiveEmployees(pool) {
  const [employees] = await pool.execute(
    `SELECT id, email
     FROM user_profiles
     WHERE role = 'employee' AND is_active = TRUE
     ORDER BY created_at ASC`,
  );
  return employees || [];
}

async function loadAssignmentCounts(pool) {
  const [counts] = await pool.execute(
    `SELECT assigned_employee_id AS employee_user_id, COUNT(*)::int AS c
     FROM loan_applications
     WHERE assigned_employee_id IS NOT NULL
     GROUP BY assigned_employee_id`,
  );
  return new Map((counts || []).map((r) => [r.employee_user_id, Number(r.c || 0)]));
}

function pickLeastLoadedEmployee(candidates) {
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.count - b.count || String(a.id).localeCompare(String(b.id)));
  return candidates[0];
}

/**
 * Auto-assign applications that need document / stage verification and have no assignee.
 * - Agent-sourced apps → employee from agent_employee_hierarchy by stage priority
 * - Direct customer apps → load-balanced across active employees
 * Also realigns assigned_employee_id to the stage-responsible hierarchy employee when mapped.
 */
export async function autoAssignApplicationsForEmployeeVerification(pool) {
  const [apps] = await pool.execute(
    `SELECT la.id, la.agent_id, la.assigned_employee_id, la.sourced_agent_code,
            la.document_stage_status, la.bank_approval_status, la.status, la.data
     FROM loan_applications la
     WHERE COALESCE(la.status, '') NOT IN ('cancelled', 'withdrawn')
       AND (
         la.assigned_employee_id IS NULL
         OR EXISTS (
           SELECT 1 FROM customer_documents cd
           WHERE cd.application_id = la.id
             AND COALESCE(cd.verification_status, cd.status, 'pending') IN ('pending', 'uploaded')
         )
         OR LOWER(CAST(COALESCE(la.document_stage_status, '') AS TEXT))
              IN ('documents_pending', 'pending', 'uploaded', 'in_review')
       )
     ORDER BY la.created_at ASC
     LIMIT 500`,
  );
  if (!apps?.length) return { assigned: 0, realigned: 0 };

  const employees = await loadActiveEmployees(pool);
  if (!employees.length) return { assigned: 0, realigned: 0 };

  const countMap = await loadAssignmentCounts(pool);
  const candidates = employees.map((e) => ({
    id: e.id,
    email: e.email || '',
    count: countMap.get(e.id) || 0,
  }));

  const appData = apps.map((app) => parseJson(app.data, {}));
  const codes = [
    ...new Set(
      apps
        .map((app, idx) =>
          normalizeAgentCode(
            app.sourced_agent_code
              || appData[idx]?.sourced_agent_code
              || appData[idx]?.sourcedAgentCode
              || appData[idx]?.agent_code
              || appData[idx]?.agentCode,
          ),
        )
        .filter(Boolean),
    ),
  ];

  const agentCodeToUser = new Map();
  if (codes.length) {
    const codeParams = {};
    const placeholders = codes.map((code, i) => {
      codeParams[`code${i}`] = code;
      return `:code${i}`;
    });
    const [codeRows] = await pool.execute(
      `SELECT user_id, agent_code
       FROM agent_onboarding
       WHERE LOWER(TRIM(CAST(agent_code AS TEXT))) IN (${placeholders.join(', ')})`,
      codeParams,
    );
    for (const row of codeRows || []) {
      agentCodeToUser.set(normalizeAgentCode(row.agent_code), row.user_id);
    }
  }

  const agentIds = [
    ...new Set(
      apps
        .map((app, idx) => {
          if (app.agent_id) return app.agent_id;
          return (
            agentCodeToUser.get(
              normalizeAgentCode(
                app.sourced_agent_code
                  || appData[idx]?.sourced_agent_code
                  || appData[idx]?.sourcedAgentCode
                  || appData[idx]?.agent_code
                  || appData[idx]?.agentCode,
              ),
            ) || null
          );
        })
        .filter(Boolean),
    ),
  ];

  const hierarchyByAgent = new Map();
  if (agentIds.length) {
    const hParams = {};
    const hPlaceholders = agentIds.map((id, i) => {
      hParams[`aid${i}`] = id;
      return `:aid${i}`;
    });
    const [hRows] = await pool.execute(
      `SELECT agent_user_id, employee_user_id, hierarchy_level, is_primary
       FROM agent_employee_hierarchy
       WHERE agent_user_id IN (${hPlaceholders.join(', ')})`,
      hParams,
    );
    for (const row of hRows || []) {
      if (!hierarchyByAgent.has(row.agent_user_id)) hierarchyByAgent.set(row.agent_user_id, []);
      hierarchyByAgent.get(row.agent_user_id).push(row);
    }
  }

  let assigned = 0;
  let realigned = 0;

  for (let i = 0; i < apps.length; i += 1) {
    const app = apps[i];
    const data = appData[i];
    const resolvedAgentId =
      app.agent_id
      || agentCodeToUser.get(
        normalizeAgentCode(
          app.sourced_agent_code
            || data?.sourced_agent_code
            || data?.sourcedAgentCode
            || data?.agent_code
            || data?.agentCode,
        ),
      )
      || null;

    const hierarchy = resolvedAgentId ? hierarchyByAgent.get(resolvedAgentId) || [] : [];
    let targetEmployeeId = resolveResponsibleEmployeeIdForStage(app, hierarchy);

    if (!targetEmployeeId) {
      const pick = pickLeastLoadedEmployee(candidates);
      if (!pick) continue;
      targetEmployeeId = pick.id;
      pick.count += 1;
    }

    if (app.assigned_employee_id === targetEmployeeId) continue;

    await pool.execute(
      `UPDATE loan_applications
       SET assigned_employee_id = :employee_id, updated_at = NOW()
       WHERE id = :id`,
      { id: app.id, employee_id: targetEmployeeId },
    );

    if (app.assigned_employee_id) realigned += 1;
    else assigned += 1;

    const cand = candidates.find((c) => c.id === targetEmployeeId);
    if (cand && !app.assigned_employee_id) cand.count += 1;
  }

  return { assigned, realigned };
}

/**
 * Application IDs this employee owns for document / application verification.
 * Runs auto-assign first so new pending docs land on someone.
 */
export async function fetchEmployeeOwnedApplicationIds(pool, employeeId, { autoAssign = true } = {}) {
  if (autoAssign) {
    await autoAssignApplicationsForEmployeeVerification(pool);
  }

  const [candidateApps] = await pool.execute(
    `SELECT la.id, la.agent_id, la.assigned_employee_id, la.sourced_agent_code,
            la.document_stage_status, la.bank_approval_status, la.status, la.data
     FROM loan_applications la
     WHERE la.assigned_employee_id = :id
        OR EXISTS (
          SELECT 1
          FROM agent_employee_hierarchy h
          LEFT JOIN agent_onboarding ao ON ao.user_id = h.agent_user_id
          WHERE h.employee_user_id = :id
            AND (
              h.agent_user_id = la.agent_id
              OR LOWER(TRIM(CAST(COALESCE(la.sourced_agent_code, '') AS TEXT))) = LOWER(TRIM(CAST(COALESCE(ao.agent_code, '') AS TEXT)))
              OR LOWER(TRIM(CAST(COALESCE(la.data->>'sourced_agent_code', '') AS TEXT))) = LOWER(TRIM(CAST(COALESCE(ao.agent_code, '') AS TEXT)))
              OR LOWER(TRIM(CAST(COALESCE(la.data->>'sourcedAgentCode', '') AS TEXT))) = LOWER(TRIM(CAST(COALESCE(ao.agent_code, '') AS TEXT)))
              OR LOWER(TRIM(CAST(COALESCE(la.data->>'agent_code', '') AS TEXT))) = LOWER(TRIM(CAST(COALESCE(ao.agent_code, '') AS TEXT)))
              OR LOWER(TRIM(CAST(COALESCE(la.data->>'agentCode', '') AS TEXT))) = LOWER(TRIM(CAST(COALESCE(ao.agent_code, '') AS TEXT)))
            )
        )`,
    { id: employeeId },
  );

  if (!candidateApps.length) return new Set();

  const appData = candidateApps.map((app) => parseJson(app.data, {}));
  const agentIds = [...new Set(candidateApps.map((r) => r.agent_id).filter(Boolean))];
  const codes = [
    ...new Set(
      candidateApps
        .map((app, idx) =>
          normalizeAgentCode(
            app.sourced_agent_code
              || appData[idx]?.sourced_agent_code
              || appData[idx]?.sourcedAgentCode
              || appData[idx]?.agent_code
              || appData[idx]?.agentCode,
          ),
        )
        .filter(Boolean),
    ),
  ];

  const agentCodeToUser = new Map();
  if (codes.length) {
    const codeParams = {};
    const codePlaceholders = codes.map((code, i) => {
      codeParams[`code${i}`] = code;
      return `:code${i}`;
    });
    const [codeRows] = await pool.execute(
      `SELECT user_id, agent_code
       FROM agent_onboarding
       WHERE LOWER(TRIM(CAST(agent_code AS TEXT))) IN (${codePlaceholders.join(', ')})`,
      codeParams,
    );
    for (const row of codeRows || []) {
      agentCodeToUser.set(normalizeAgentCode(row.agent_code), row.user_id);
      if (row.user_id) agentIds.push(row.user_id);
    }
  }

  const uniqueAgentIds = [...new Set(agentIds.filter(Boolean))];
  const hierarchyByAgent = new Map();
  if (uniqueAgentIds.length) {
    const hParams = {};
    const hPlaceholders = uniqueAgentIds.map((id, i) => {
      hParams[`aid${i}`] = id;
      return `:aid${i}`;
    });
    const [hRows] = await pool.execute(
      `SELECT agent_user_id, employee_user_id, hierarchy_level, is_primary
       FROM agent_employee_hierarchy
       WHERE agent_user_id IN (${hPlaceholders.join(', ')})`,
      hParams,
    );
    for (const row of hRows || []) {
      if (!hierarchyByAgent.has(row.agent_user_id)) hierarchyByAgent.set(row.agent_user_id, []);
      hierarchyByAgent.get(row.agent_user_id).push(row);
    }
  }

  const allowedIds = new Set();
  for (let i = 0; i < candidateApps.length; i += 1) {
    const app = candidateApps[i];
    const d = appData[i];
    const resolvedAgentId =
      app.agent_id
      || agentCodeToUser.get(
        normalizeAgentCode(
          app.sourced_agent_code
            || d?.sourced_agent_code
            || d?.sourcedAgentCode
            || d?.agent_code
            || d?.agentCode,
        ),
      )
      || null;
    const ownerId = resolveResponsibleEmployeeIdForStage(
      app,
      resolvedAgentId ? hierarchyByAgent.get(resolvedAgentId) || [] : [],
    );
    if (ownerId === employeeId || app.assigned_employee_id === employeeId) {
      allowedIds.add(app.id);
    }
  }
  return allowedIds;
}

/** Ensure agent→employee hierarchy mapping exists for pending agent QC (used by milestone4). */
export async function autoAssignPendingAgentsToEmployees(pool) {
  const [pendingAgents] = await pool.execute(
    `SELECT ao.user_id
     FROM agent_onboarding ao
     JOIN user_profiles up ON up.id = ao.user_id
     WHERE CAST(ao.qc_status AS TEXT) IN ('pending_qc', 'qc_review')
       AND up.role = 'agent'`,
  );
  if (!pendingAgents.length) return;

  const pendingIds = pendingAgents.map((r) => r.user_id);
  const params = {};
  const pendingPlaceholders = pendingIds.map((id, i) => {
    params[`aid${i}`] = id;
    return `:aid${i}`;
  });

  const [existingMappings] = await pool.execute(
    `SELECT agent_user_id
     FROM agent_employee_hierarchy
     WHERE agent_user_id IN (${pendingPlaceholders.join(', ')})`,
    params,
  );

  const alreadyMappedAgents = new Set((existingMappings || []).map((r) => r.agent_user_id));
  const unmappedAgentIds = pendingIds.filter((id) => !alreadyMappedAgents.has(id));
  if (!unmappedAgentIds.length) return;

  const employees = await loadActiveEmployees(pool);
  if (!employees.length) return;

  const [counts] = await pool.execute(
    `SELECT employee_user_id, COUNT(*)::int AS c
     FROM agent_employee_hierarchy
     GROUP BY employee_user_id`,
  );
  const countMap = new Map((counts || []).map((r) => [r.employee_user_id, Number(r.c || 0)]));
  const candidates = employees.map((e) => ({
    id: e.id,
    email: e.email || '',
    count: countMap.get(e.id) || 0,
  }));

  for (const agentUserId of unmappedAgentIds) {
    const pick = pickLeastLoadedEmployee(candidates);
    if (!pick) break;

    const [[exists]] = await pool.execute(
      `SELECT id FROM agent_employee_hierarchy WHERE agent_user_id = :agent_user_id LIMIT 1`,
      { agent_user_id: agentUserId },
    );
    if (exists?.id) continue;

    await pool.execute(
      `INSERT INTO agent_employee_hierarchy
       (id, agent_user_id, employee_user_id, communication_email, hierarchy_level, is_primary, notes, created_by)
       VALUES
       (:id, :agent_user_id, :employee_user_id, :communication_email, 1, 1, :notes, :created_by)`,
      {
        id: newId(),
        agent_user_id: agentUserId,
        employee_user_id: pick.id,
        communication_email: pick.email,
        notes: 'Auto-assigned for QC verification',
        created_by: 'system:auto-assign',
      },
    );
    pick.count += 1;
  }
}
