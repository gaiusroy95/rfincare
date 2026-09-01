import { getPool } from '../db/pool.js';
import { newId } from './ids.js';

let schemaReady = false;

export async function ensurePolicyConsoleSchema(pool = getPool()) {
  if (schemaReady) return;
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS product_policy_versions (
      id CHAR(36) NOT NULL,
      bank_id CHAR(36) NOT NULL,
      bank_product_id CHAR(36) NULL,
      external_product_id VARCHAR(128) NULL,
      version_label VARCHAR(64) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'draft',
      effective_from DATE NULL,
      effective_to DATE NULL,
      change_reason TEXT NULL,
      snapshot_json JSON NULL,
      created_by CHAR(36) NULL,
      submitted_by CHAR(36) NULL,
      submitted_at TIMESTAMPTZ NULL,
      approved_by CHAR(36) NULL,
      approved_at TIMESTAMPTZ NULL,
      published_by CHAR(36) NULL,
      published_at TIMESTAMPTZ NULL,
      rejected_by CHAR(36) NULL,
      rejected_at TIMESTAMPTZ NULL,
      rejection_reason TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS policy_change_audit (
      id CHAR(36) NOT NULL,
      version_id CHAR(36) NULL,
      bank_product_id CHAR(36) NULL,
      bank_id CHAR(36) NULL,
      action VARCHAR(64) NOT NULL,
      field_path VARCHAR(255) NULL,
      old_value JSON NULL,
      new_value JSON NULL,
      change_reason TEXT NULL,
      actor_id CHAR(36) NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS eligibility_rules (
      id CHAR(36) NOT NULL,
      version_id CHAR(36) NULL,
      bank_id CHAR(36) NULL,
      bank_product_id CHAR(36) NULL,
      rule_domain VARCHAR(64) NOT NULL DEFAULT 'applicant',
      rule_code VARCHAR(128) NULL,
      rule_name VARCHAR(255) NOT NULL,
      severity VARCHAR(32) NOT NULL DEFAULT 'soft',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INT NOT NULL DEFAULT 0,
      source_sheet VARCHAR(64) NULL,
      source_row_json JSON NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS eligibility_conditions (
      id CHAR(36) NOT NULL,
      rule_id CHAR(36) NOT NULL,
      field_key VARCHAR(128) NOT NULL,
      operator VARCHAR(32) NOT NULL DEFAULT '>=',
      value_json JSON NULL,
      value_to_json JSON NULL,
      logic_group VARCHAR(32) NOT NULL DEFAULT 'AND',
      sort_order INT NOT NULL DEFAULT 0,
      PRIMARY KEY (id)
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS property_ltv_rules (
      id CHAR(36) NOT NULL,
      version_id CHAR(36) NULL,
      bank_id CHAR(36) NULL,
      bank_product_id CHAR(36) NULL,
      property_type VARCHAR(128) NOT NULL DEFAULT 'residential',
      max_ltv NUMERIC(8, 4) NOT NULL DEFAULT 0.75,
      min_amount NUMERIC(18, 2) NULL,
      max_amount NUMERIC(18, 2) NULL,
      applicant_type VARCHAR(64) NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      data_json JSON NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS dscr_rules (
      id CHAR(36) NOT NULL,
      version_id CHAR(36) NULL,
      bank_id CHAR(36) NULL,
      bank_product_id CHAR(36) NULL,
      min_dscr NUMERIC(8, 4) NOT NULL DEFAULT 1.25,
      notes TEXT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS risk_exception_rules (
      id CHAR(36) NOT NULL,
      version_id CHAR(36) NULL,
      bank_id CHAR(36) NULL,
      bank_product_id CHAR(36) NULL,
      rule_type VARCHAR(32) NOT NULL DEFAULT 'risk',
      rule_code VARCHAR(128) NULL,
      description TEXT NULL,
      severity VARCHAR(32) NOT NULL DEFAULT 'soft',
      condition_json JSON NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS matching_engine_config (
      id VARCHAR(64) NOT NULL DEFAULT 'default',
      weights_json JSON NOT NULL,
      decision_thresholds_json JSON NOT NULL,
      updated_by CHAR(36) NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    )
  `);
  await pool.execute(`
    INSERT INTO matching_engine_config (id, weights_json, decision_thresholds_json)
    VALUES (
      'default',
      '{"income_mismatch":25,"credit_mismatch":20,"loan_amount_mismatch":20,"employment_mismatch":15,"loan_type_mismatch":10,"age_mismatch":18,"stability_mismatch":10,"emi_capacity_mismatch":12,"ltv_mismatch":10,"critical_fail_penalty":100}'::json,
      '{"eligible_min_probability":70,"conditional_min_probability":50}'::json
    )
    ON CONFLICT (id) DO NOTHING
  `);
  schemaReady = true;
}

export async function writePolicyAudit({
  versionId = null,
  bankProductId = null,
  bankId = null,
  action,
  fieldPath = null,
  oldValue = null,
  newValue = null,
  changeReason = null,
  actorId = null,
  conn = null,
}) {
  const db = conn || getPool();
  await db.execute(
    `INSERT INTO policy_change_audit (
       id, version_id, bank_product_id, bank_id, action, field_path,
       old_value, new_value, change_reason, actor_id
     ) VALUES (
       :id, :version_id, :bank_product_id, :bank_id, :action, :field_path,
       :old_value, :new_value, :change_reason, :actor_id
     )`,
    {
      id: newId(),
      version_id: versionId,
      bank_product_id: bankProductId,
      bank_id: bankId,
      action,
      field_path: fieldPath,
      old_value: oldValue != null ? JSON.stringify(oldValue) : null,
      new_value: newValue != null ? JSON.stringify(newValue) : null,
      change_reason: changeReason,
      actor_id: actorId,
    },
  );
}

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function listPolicyVersions({ status, bankId, limit = 100 } = {}) {
  await ensurePolicyConsoleSchema();
  const pool = getPool();
  const clauses = [];
  const params = { limit: Math.min(Number(limit) || 100, 500) };
  if (status) {
    clauses.push('v.status = :status');
    params.status = status;
  }
  if (bankId) {
    clauses.push('v.bank_id = :bank_id');
    params.bank_id = bankId;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT v.*, b.name AS bank_name, bp.name AS product_name
     FROM product_policy_versions v
     LEFT JOIN banks b ON b.id = v.bank_id
     LEFT JOIN bank_products bp ON bp.id = v.bank_product_id
     ${where}
     ORDER BY v.updated_at DESC
     LIMIT :limit`,
    params,
  );
  return rows.map((r) => ({ ...r, snapshot_json: parseJson(r.snapshot_json) }));
}

export async function getPolicyVersion(id) {
  await ensurePolicyConsoleSchema();
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT v.*, b.name AS bank_name, bp.name AS product_name
     FROM product_policy_versions v
     LEFT JOIN banks b ON b.id = v.bank_id
     LEFT JOIN bank_products bp ON bp.id = v.bank_product_id
     WHERE v.id = :id`,
    { id },
  );
  if (!rows[0]) return null;
  const version = { ...rows[0], snapshot_json: parseJson(rows[0].snapshot_json) };
  const [rules] = await pool.query(
    `SELECT * FROM eligibility_rules WHERE version_id = :id ORDER BY sort_order, created_at`,
    { id },
  );
  const ruleIds = rules.map((r) => r.id);
  let conditions = [];
  if (ruleIds.length) {
    const placeholders = ruleIds.map((_, i) => `:id${i}`).join(',');
    const p = {};
    ruleIds.forEach((rid, i) => { p[`id${i}`] = rid; });
    const [conds] = await pool.query(
      `SELECT * FROM eligibility_conditions WHERE rule_id IN (${placeholders}) ORDER BY sort_order`,
      p,
    );
    conditions = conds;
  }
  const [ltv] = await pool.query(`SELECT * FROM property_ltv_rules WHERE version_id = :id`, { id });
  const [dscr] = await pool.query(`SELECT * FROM dscr_rules WHERE version_id = :id`, { id });
  const [risk] = await pool.query(`SELECT * FROM risk_exception_rules WHERE version_id = :id`, { id });
  return {
    ...version,
    rules: rules.map((r) => ({
      ...r,
      source_row_json: parseJson(r.source_row_json),
      conditions: conditions
        .filter((c) => c.rule_id === r.id)
        .map((c) => ({
          ...c,
          value_json: parseJson(c.value_json),
          value_to_json: parseJson(c.value_to_json),
        })),
    })),
    propertyLtvRules: ltv,
    dscrRules: dscr,
    riskRules: risk,
  };
}

export async function createDraftVersion({
  bankId,
  bankProductId = null,
  externalProductId = null,
  versionLabel,
  changeReason = null,
  effectiveFrom = null,
  effectiveTo = null,
  snapshot = null,
  actorId = null,
  conn = null,
}) {
  await ensurePolicyConsoleSchema();
  const db = conn || getPool();
  const id = newId();
  let productData = snapshot;
  if (!productData && bankProductId) {
    const [rows] = await db.query(`SELECT data FROM bank_products WHERE id = :id`, { id: bankProductId });
    productData = parseJson(rows[0]?.data) || {};
  }
  await db.execute(
    `INSERT INTO product_policy_versions (
       id, bank_id, bank_product_id, external_product_id, version_label, status,
       effective_from, effective_to, change_reason, snapshot_json, created_by
     ) VALUES (
       :id, :bank_id, :bank_product_id, :external_product_id, :version_label, 'draft',
       :effective_from, :effective_to, :change_reason, :snapshot_json, :created_by
     )`,
    {
      id,
      bank_id: bankId,
      bank_product_id: bankProductId,
      external_product_id: externalProductId,
      version_label: versionLabel || 'v1',
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      change_reason: changeReason,
      snapshot_json: productData ? JSON.stringify(productData) : null,
      created_by: actorId,
    },
  );
  await writePolicyAudit({
    versionId: id,
    bankProductId,
    bankId,
    action: 'version_created',
    newValue: { versionLabel, status: 'draft' },
    changeReason,
    actorId,
    conn: db,
  });
  return id;
}

async function transitionVersion(id, {
  fromStatuses,
  toStatus,
  actorId,
  reason = null,
  extraSets = {},
}) {
  await ensurePolicyConsoleSchema();
  const pool = getPool();
  const [rows] = await pool.query(`SELECT * FROM product_policy_versions WHERE id = :id`, { id });
  const version = rows[0];
  if (!version) {
    const e = new Error('Policy version not found');
    e.status = 404;
    throw e;
  }
  if (!fromStatuses.includes(version.status)) {
    const e = new Error(`Cannot move version from ${version.status} to ${toStatus}`);
    e.status = 400;
    throw e;
  }

  const sets = ['status = :status', 'updated_at = NOW()', ...Object.keys(extraSets).map((k) => `${k} = :${k}`)];
  const params = {
    id,
    status: toStatus,
    ...extraSets,
  };
  await pool.execute(
    `UPDATE product_policy_versions SET ${sets.join(', ')} WHERE id = :id`,
    params,
  );
  await writePolicyAudit({
    versionId: id,
    bankProductId: version.bank_product_id,
    bankId: version.bank_id,
    action: `version_${toStatus}`,
    oldValue: { status: version.status },
    newValue: { status: toStatus, reason },
    changeReason: reason,
    actorId,
  });
  return getPolicyVersion(id);
}

export async function submitVersion(id, actorId, reason) {
  return transitionVersion(id, {
    fromStatuses: ['draft', 'rejected'],
    toStatus: 'submitted',
    actorId,
    reason,
    extraSets: { submitted_by: actorId, submitted_at: new Date().toISOString() },
  });
}

export async function approveVersion(id, actorId, reason) {
  return transitionVersion(id, {
    fromStatuses: ['submitted'],
    toStatus: 'approved',
    actorId,
    reason,
    extraSets: { approved_by: actorId, approved_at: new Date().toISOString() },
  });
}

export async function rejectVersion(id, actorId, reason) {
  return transitionVersion(id, {
    fromStatuses: ['submitted', 'approved'],
    toStatus: 'rejected',
    actorId,
    reason,
    extraSets: {
      rejected_by: actorId,
      rejected_at: new Date().toISOString(),
      rejection_reason: reason || 'Rejected',
    },
  });
}

export async function publishVersion(id, actorId, reason) {
  await ensurePolicyConsoleSchema();
  const pool = getPool();
  const [rows] = await pool.query(`SELECT * FROM product_policy_versions WHERE id = :id`, { id });
  const version = rows[0];
  if (!version) {
    const e = new Error('Policy version not found');
    e.status = 404;
    throw e;
  }
  if (!['approved', 'scheduled'].includes(version.status)) {
    const e = new Error('Only approved or scheduled versions can be published');
    e.status = 400;
    throw e;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (version.bank_product_id) {
      await conn.execute(
        `UPDATE product_policy_versions SET status = 'superseded', updated_at = NOW()
         WHERE bank_product_id = :pid AND status = 'active' AND id <> :id`,
        { pid: version.bank_product_id, id },
      );
      const snap = parseJson(version.snapshot_json) || {};
      snap.policy_version = version.version_label;
      snap.policy_version_id = id;
      snap.policy_published_at = new Date().toISOString();
      await conn.execute(
        `UPDATE bank_products SET data = :data, updated_at = NOW() WHERE id = :pid`,
        { pid: version.bank_product_id, data: JSON.stringify(snap) },
      );
    }
    await conn.execute(
      `UPDATE product_policy_versions SET
         status = 'active', published_by = :by, published_at = NOW(), updated_at = NOW()
       WHERE id = :id`,
      { id, by: actorId },
    );
    await activateVersionPolicyData(conn, version);
    await writePolicyAudit({
      versionId: id,
      bankProductId: version.bank_product_id,
      bankId: version.bank_id,
      action: 'version_published',
      oldValue: { status: version.status },
      newValue: { status: 'active' },
      changeReason: reason,
      actorId,
      conn,
    });
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return getPolicyVersion(id);
}

/** On publish: only rules/LTV/DSCR/risk rows for this version are live for the lender scope. */
async function activateVersionPolicyData(conn, version) {
  const scopeParams = {
    bank_id: version.bank_id,
    pid: version.bank_product_id || null,
    version_id: version.id,
  };
  const productClause = version.bank_product_id
    ? 'AND (bank_product_id = :pid OR bank_product_id IS NULL)'
    : 'AND bank_product_id IS NULL';

  for (const table of [
    'eligibility_rules',
    'property_ltv_rules',
    'dscr_rules',
    'risk_exception_rules',
  ]) {
    const ts = table === 'eligibility_rules' ? ', updated_at = NOW()' : '';
    await conn.execute(
      `UPDATE ${table} SET is_active = FALSE${ts}
       WHERE bank_id = :bank_id ${productClause}
         AND version_id IS NOT NULL AND version_id <> :version_id`,
      scopeParams,
    );
    await conn.execute(
      `UPDATE ${table} SET is_active = TRUE${ts}
       WHERE version_id = :version_id`,
      { version_id: version.id },
    );
  }
}

export async function listPolicyAudit({ versionId, limit = 100 } = {}) {
  await ensurePolicyConsoleSchema();
  const pool = getPool();
  const params = { limit: Math.min(Number(limit) || 100, 500) };
  let where = '';
  if (versionId) {
    where = 'WHERE version_id = :version_id';
    params.version_id = versionId;
  }
  const [rows] = await pool.query(
    `SELECT * FROM policy_change_audit ${where} ORDER BY created_at DESC LIMIT :limit`,
    params,
  );
  return rows.map((r) => ({
    ...r,
    old_value: parseJson(r.old_value),
    new_value: parseJson(r.new_value),
  }));
}

export async function createEligibilityRule({
  versionId = null,
  bankId = null,
  bankProductId = null,
  ruleDomain = 'applicant',
  ruleCode = null,
  ruleName,
  severity = 'soft',
  sortOrder = 0,
  sourceSheet = null,
  sourceRow = null,
  conditions = [],
  conn = null,
}) {
  await ensurePolicyConsoleSchema();
  const db = conn || getPool();
  const ruleId = newId();
  await db.execute(
    `INSERT INTO eligibility_rules (
       id, version_id, bank_id, bank_product_id, rule_domain, rule_code, rule_name,
       severity, sort_order, source_sheet, source_row_json
     ) VALUES (
       :id, :version_id, :bank_id, :bank_product_id, :rule_domain, :rule_code, :rule_name,
       :severity, :sort_order, :source_sheet, :source_row_json
     )`,
    {
      id: ruleId,
      version_id: versionId,
      bank_id: bankId,
      bank_product_id: bankProductId,
      rule_domain: ruleDomain,
      rule_code: ruleCode,
      rule_name: ruleName,
      severity,
      sort_order: sortOrder,
      source_sheet: sourceSheet,
      source_row_json: sourceRow ? JSON.stringify(sourceRow) : null,
    },
  );
  for (let i = 0; i < conditions.length; i += 1) {
    const c = conditions[i];
    await db.execute(
      `INSERT INTO eligibility_conditions (
         id, rule_id, field_key, operator, value_json, value_to_json, logic_group, sort_order
       ) VALUES (
         :id, :rule_id, :field_key, :operator, :value_json, :value_to_json, :logic_group, :sort_order
       )`,
      {
        id: newId(),
        rule_id: ruleId,
        field_key: c.fieldKey || c.field_key,
        operator: c.operator || '>=',
        value_json: JSON.stringify(c.value ?? c.value_json ?? null),
        value_to_json: c.valueTo != null || c.value_to_json != null
          ? JSON.stringify(c.valueTo ?? c.value_to_json)
          : null,
        logic_group: c.logicGroup || c.logic_group || 'AND',
        sort_order: c.sortOrder ?? i,
      },
    );
  }
  return ruleId;
}

/**
 * Rules used by eligibility/matching at runtime.
 * When a lender has a published policy version, only rules from active versions apply.
 */
export async function listEngineEligibilityRules({ bankId } = {}) {
  await ensurePolicyConsoleSchema();
  const pool = getPool();
  const params = {};
  let bankFilter = '';
  if (bankId) {
    bankFilter = 'AND er.bank_id = :bank_id';
    params.bank_id = bankId;
  }
  const [rules] = await pool.query(
    `SELECT er.* FROM eligibility_rules er
     LEFT JOIN product_policy_versions ppv ON ppv.id = er.version_id
     WHERE er.is_active = TRUE
     ${bankFilter}
     AND (
       (er.version_id IS NOT NULL AND ppv.status = 'active')
       OR (
         er.version_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM product_policy_versions v
           WHERE v.status = 'active'
             AND (er.bank_id IS NULL OR v.bank_id = er.bank_id)
         )
       )
     )
     ORDER BY er.sort_order ASC, er.created_at DESC
     LIMIT 500`,
    params,
  );
  if (!rules.length) return [];
  const placeholders = rules.map((_, i) => `:id${i}`).join(',');
  const p = {};
  rules.forEach((r, i) => { p[`id${i}`] = r.id; });
  const [conds] = await pool.query(
    `SELECT * FROM eligibility_conditions WHERE rule_id IN (${placeholders}) ORDER BY sort_order`,
    p,
  );
  return rules.map((r) => ({
    ...r,
    source_row_json: parseJson(r.source_row_json),
    conditions: conds
      .filter((c) => c.rule_id === r.id)
      .map((c) => ({
        ...c,
        value_json: parseJson(c.value_json),
        value_to_json: parseJson(c.value_to_json),
      })),
  }));
}

export async function listEligibilityRules({ bankId, versionId, domain } = {}) {
  await ensurePolicyConsoleSchema();
  const pool = getPool();
  const clauses = ['is_active = TRUE'];
  const params = {};
  if (bankId) {
    clauses.push('bank_id = :bank_id');
    params.bank_id = bankId;
  }
  if (versionId) {
    clauses.push('version_id = :version_id');
    params.version_id = versionId;
  }
  if (domain) {
    clauses.push('rule_domain = :domain');
    params.domain = domain;
  }
  const [rules] = await pool.query(
    `SELECT * FROM eligibility_rules WHERE ${clauses.join(' AND ')} ORDER BY sort_order, created_at DESC LIMIT 500`,
    params,
  );
  if (!rules.length) return [];
  const placeholders = rules.map((_, i) => `:id${i}`).join(',');
  const p = {};
  rules.forEach((r, i) => { p[`id${i}`] = r.id; });
  const [conds] = await pool.query(
    `SELECT * FROM eligibility_conditions WHERE rule_id IN (${placeholders}) ORDER BY sort_order`,
    p,
  );
  return rules.map((r) => ({
    ...r,
    source_row_json: parseJson(r.source_row_json),
    conditions: conds
      .filter((c) => c.rule_id === r.id)
      .map((c) => ({
        ...c,
        value_json: parseJson(c.value_json),
        value_to_json: parseJson(c.value_to_json),
      })),
  }));
}
