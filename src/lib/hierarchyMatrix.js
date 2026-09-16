import { getPool, isDuplicateColumnError, isIgnorableMigrationError } from '../db/pool.js';
import { newId } from './ids.js';

export const HIERARCHY_LEVELS = [1, 2, 3, 4];

let matrixSchemaReady = false;

export async function ensureHierarchyMatrixSchema(pool = getPool()) {
  if (matrixSchemaReady) return;
  try {
    // Keep one row per (agent, level) — prefer primary, then earliest created.
    await pool.execute(`
      DELETE FROM agent_employee_hierarchy a
      USING agent_employee_hierarchy b
      WHERE a.agent_user_id = b.agent_user_id
        AND a.hierarchy_level = b.hierarchy_level
        AND a.hierarchy_level BETWEEN 1 AND 4
        AND a.id <> b.id
        AND (
          (COALESCE(a.is_primary, FALSE) = FALSE AND COALESCE(b.is_primary, FALSE) = TRUE)
          OR (
            COALESCE(a.is_primary, FALSE) = COALESCE(b.is_primary, FALSE)
            AND a.created_at > b.created_at
          )
          OR (
            COALESCE(a.is_primary, FALSE) = COALESCE(b.is_primary, FALSE)
            AND a.created_at = b.created_at
            AND a.id > b.id
          )
        )
    `);
  } catch (err) {
    console.warn('[hierarchy-matrix] dedupe skipped:', err.message || err);
  }
  try {
    await pool.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_hierarchy_level
      ON agent_employee_hierarchy (agent_user_id, hierarchy_level)
    `);
  } catch (err) {
    if (!isDuplicateColumnError(err) && !isIgnorableMigrationError(err) && err?.code !== '23505') {
      console.warn('[hierarchy-matrix] unique index skipped:', err.message || err);
    }
  }
  matrixSchemaReady = true;
}

function pickEmployeeEmail(employeeRow, fallbackEmail) {
  const email = String(fallbackEmail || employeeRow?.email || '').trim().toLowerCase();
  return email || null;
}

/**
 * Upsert one employee per level (1–4) for an agent.
 * Clears a level when employeeUserId is null/empty.
 */
export async function upsertAgentHierarchyMatrix(
  pool,
  {
    agentUserId,
    levelEmployees = {},
    communicationEmail = null,
    notes = null,
    createdBy = null,
  },
) {
  await ensureHierarchyMatrixSchema(pool);
  if (!agentUserId) {
    const err = new Error('agentUserId is required');
    err.status = 400;
    throw err;
  }

  const results = [];
  let primaryAssigned = false;

  // Same employee cannot occupy two levels for one agent.
  const chosen = Object.entries(levelEmployees)
    .map(([lvl, id]) => [Number(lvl), String(id || '').trim()])
    .filter(([, id]) => id);
  const seen = new Set();
  for (const [lvl, id] of chosen) {
    if (seen.has(id)) {
      const err = new Error(`The same employee cannot be mapped to multiple levels (conflict at Level-${lvl})`);
      err.status = 400;
      throw err;
    }
    seen.add(id);
  }

  for (const level of HIERARCHY_LEVELS) {
    const employeeUserId = String(levelEmployees[level] || levelEmployees[`l${level}`] || '').trim();
    const [[existingAtLevel]] = await pool.execute(
      `SELECT id, employee_user_id FROM agent_employee_hierarchy
       WHERE agent_user_id = :agent AND hierarchy_level = :level
       LIMIT 1`,
      { agent: agentUserId, level },
    );

    if (!employeeUserId) {
      if (existingAtLevel?.id) {
        await pool.execute(`DELETE FROM agent_employee_hierarchy WHERE id = :id`, {
          id: existingAtLevel.id,
        });
        results.push({ level, action: 'cleared' });
      }
      continue;
    }

    const [[employee]] = await pool.execute(
      `SELECT id, email, full_name FROM user_profiles
       WHERE id = :id AND role = 'employee' LIMIT 1`,
      { id: employeeUserId },
    );
    if (!employee) {
      const err = new Error(`Level ${level}: employee not found`);
      err.status = 400;
      throw err;
    }

    const email = pickEmployeeEmail(employee, communicationEmail);
    if (!email) {
      const err = new Error(`Level ${level}: employee has no email for communication routing`);
      err.status = 400;
      throw err;
    }

    const isPrimary = !primaryAssigned;
    if (isPrimary) {
      await pool.execute(
        `UPDATE agent_employee_hierarchy SET is_primary = FALSE WHERE agent_user_id = :agent`,
        { agent: agentUserId },
      );
      primaryAssigned = true;
    }

    // Same employee already mapped at another level for this agent?
    const [[existingEmp]] = await pool.execute(
      `SELECT id, hierarchy_level FROM agent_employee_hierarchy
       WHERE agent_user_id = :agent AND employee_user_id = :emp LIMIT 1`,
      { agent: agentUserId, emp: employeeUserId },
    );

    if (existingAtLevel?.id) {
      await pool.execute(
        `UPDATE agent_employee_hierarchy SET
           employee_user_id = :emp,
           communication_email = :email,
           is_primary = :primary,
           notes = COALESCE(:notes, notes),
           updated_at = NOW()
         WHERE id = :id`,
        {
          id: existingAtLevel.id,
          emp: employeeUserId,
          email,
          primary: isPrimary,
          notes: notes || null,
        },
      );
      // If employee was previously on another level row, remove that duplicate row.
      if (existingEmp?.id && existingEmp.id !== existingAtLevel.id) {
        await pool.execute(`DELETE FROM agent_employee_hierarchy WHERE id = :id`, {
          id: existingEmp.id,
        });
      }
      results.push({ level, action: 'updated', employeeUserId });
    } else if (existingEmp?.id) {
      await pool.execute(
        `UPDATE agent_employee_hierarchy SET
           hierarchy_level = :level,
           communication_email = :email,
           is_primary = :primary,
           notes = COALESCE(:notes, notes),
           updated_at = NOW()
         WHERE id = :id`,
        {
          id: existingEmp.id,
          level,
          email,
          primary: isPrimary,
          notes: notes || null,
        },
      );
      results.push({ level, action: 'moved', employeeUserId });
    } else {
      await pool.execute(
        `INSERT INTO agent_employee_hierarchy
           (id, agent_user_id, employee_user_id, communication_email, hierarchy_level, is_primary, notes, created_by)
         VALUES
           (:id, :agent, :emp, :email, :level, :primary, :notes, :created_by)`,
        {
          id: newId(),
          agent: agentUserId,
          emp: employeeUserId,
          email,
          level,
          primary: isPrimary,
          notes: notes || null,
          created_by: createdBy || null,
        },
      );
      results.push({ level, action: 'created', employeeUserId });
    }
  }

  return results;
}

export async function listAgentHierarchyMatrix(pool = getPool()) {
  await ensureHierarchyMatrixSchema(pool);
  const [rows] = await pool.execute(
    `SELECT h.*,
            ag.full_name AS agent_name, ag.email AS agent_email, ao.agent_code,
            em.full_name AS employee_name, em.email AS employee_email, eo.employee_code
     FROM agent_employee_hierarchy h
     LEFT JOIN user_profiles ag ON ag.id = h.agent_user_id
     LEFT JOIN agent_onboarding ao ON ao.user_id = h.agent_user_id
     LEFT JOIN user_profiles em ON em.id = h.employee_user_id
     LEFT JOIN employee_onboarding eo ON eo.user_id = h.employee_user_id
     WHERE h.hierarchy_level BETWEEN 1 AND 4
     ORDER BY ag.full_name ASC NULLS LAST, h.hierarchy_level ASC, h.is_primary DESC`,
  );

  const byAgent = new Map();
  for (const r of rows || []) {
    if (!r.agent_user_id) continue;
    if (!byAgent.has(r.agent_user_id)) {
      byAgent.set(r.agent_user_id, {
        agentUserId: r.agent_user_id,
        agentName: r.agent_name,
        agentEmail: r.agent_email,
        agentCode: r.agent_code,
        communicationEmail: r.communication_email,
        notes: r.notes,
        levels: {
          1: null,
          2: null,
          3: null,
          4: null,
        },
        mappingIds: {},
      });
    }
    const entry = byAgent.get(r.agent_user_id);
    const level = Number(r.hierarchy_level);
    if (![1, 2, 3, 4].includes(level)) continue;
    // Prefer primary / first seen for a level.
    if (!entry.levels[level]) {
      entry.levels[level] = {
        mappingId: r.id,
        employeeUserId: r.employee_user_id,
        employeeName: r.employee_name,
        employeeCode: r.employee_code,
        employeeEmail: r.employee_email,
        isPrimary: Boolean(r.is_primary),
      };
      entry.mappingIds[level] = r.id;
      if (r.is_primary || !entry.communicationEmail) {
        entry.communicationEmail = r.communication_email || entry.communicationEmail;
      }
      if (r.notes && !entry.notes) entry.notes = r.notes;
    }
  }

  return Array.from(byAgent.values()).map((row) => ({
    ...row,
    level1: row.levels[1],
    level2: row.levels[2],
    level3: row.levels[3],
    level4: row.levels[4],
    hasEmail: Boolean(row.communicationEmail || row.agentEmail),
  }));
}

export async function deleteAgentHierarchyMatrix(pool, agentUserId) {
  await ensureHierarchyMatrixSchema(pool);
  const [result] = await pool.execute(
    `DELETE FROM agent_employee_hierarchy
     WHERE agent_user_id = :agent AND hierarchy_level BETWEEN 1 AND 4`,
    { agent: agentUserId },
  );
  return result?.affectedRows ?? 0;
}
