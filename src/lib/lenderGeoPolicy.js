import { getPool } from '../db/pool.js';
import { newId } from './ids.js';

let schemaReady = false;

export async function ensureLenderGeoPolicySchema(pool = getPool()) {
  if (schemaReady) return;
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS lender_geo_policy_versions (
      id CHAR(36) NOT NULL PRIMARY KEY,
      version_label VARCHAR(64) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'draft',
      change_reason TEXT NULL,
      effective_from DATE NULL,
      effective_to DATE NULL,
      source_job_id CHAR(36) NULL,
      uploaded_by CHAR(36) NULL,
      approved_by CHAR(36) NULL,
      approved_at TIMESTAMPTZ NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS lender_geo_coverage (
      id CHAR(36) NOT NULL PRIMARY KEY,
      version_id CHAR(36) NOT NULL,
      bank_id CHAR(36) NOT NULL,
      geo_level VARCHAR(32) NOT NULL DEFAULT 'pincode',
      state_id CHAR(36) NULL,
      state_name VARCHAR(120) NULL,
      district_id CHAR(36) NULL,
      district_name VARCHAR(120) NULL,
      tehsil_id CHAR(36) NULL,
      tehsil_name VARCHAR(120) NULL,
      pincode VARCHAR(10) NULL,
      coverage_type VARCHAR(32) NOT NULL DEFAULT 'INCLUDE',
      branch_id CHAR(36) NULL,
      branch_code VARCHAR(64) NULL,
      radius_km NUMERIC(10, 2) NULL,
      condition_json JSONB NULL,
      remarks TEXT NULL,
      priority INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  schemaReady = true;
}

function normalizeCoverageType(raw) {
  const t = String(raw || 'INCLUDE')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');
  if (['SERVICEABLE', 'INCLUDED', 'YES', 'COVERED'].includes(t)) return 'INCLUDE';
  if (['NOT_SERVICEABLE', 'EXCLUDED', 'NO', 'NEGATIVE', 'NOT_COVERED'].includes(t)) return 'EXCLUDE';
  if (['BRANCH', 'BRANCH-DEPENDENT'].includes(t)) return 'BRANCH_DEPENDENT';
  if (['INCLUDE', 'EXCLUDE', 'CONDITIONAL', 'BRANCH_DEPENDENT'].includes(t)) return t;
  return 'INCLUDE';
}

function normalizePin(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length >= 6 ? digits.slice(0, 6) : null;
}

/** Active coverage rows grouped by bank_id */
export async function loadActiveGeoCoverageByBank(pool = getPool()) {
  await ensureLenderGeoPolicySchema(pool);
  const [versions] = await pool.query(
    `SELECT id FROM lender_geo_policy_versions
     WHERE status = 'active'
     ORDER BY approved_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
  );
  if (!versions.length) {
    return { versionId: null, byBank: new Map(), bankIdsWithPolicy: new Set() };
  }
  const versionId = versions[0].id;
  const [rows] = await pool.query(
    `SELECT * FROM lender_geo_coverage WHERE version_id = :version_id`,
    { version_id: versionId },
  );
  const byBank = new Map();
  const bankIdsWithPolicy = new Set();
  for (const row of rows) {
    bankIdsWithPolicy.add(row.bank_id);
    if (!byBank.has(row.bank_id)) byBank.set(row.bank_id, []);
    byBank.get(row.bank_id).push(row);
  }
  return { versionId, byBank, bankIdsWithPolicy };
}

export async function listGeoPolicyVersions(limit = 30) {
  const pool = getPool();
  await ensureLenderGeoPolicySchema(pool);
  const [rows] = await pool.query(
    `SELECT * FROM lender_geo_policy_versions
     ORDER BY created_at DESC
     LIMIT :limit`,
    { limit: Math.min(Number(limit) || 30, 100) },
  );
  return rows;
}

export async function getGeoPolicyVersion(versionId) {
  const pool = getPool();
  await ensureLenderGeoPolicySchema(pool);
  const [[version]] = await pool.query(
    `SELECT * FROM lender_geo_policy_versions WHERE id = :id`,
    { id: versionId },
  );
  if (!version) return null;
  const [rows] = await pool.query(
    `SELECT c.*, b.name AS bank_name
     FROM lender_geo_coverage c
     LEFT JOIN banks b ON b.id = c.bank_id
     WHERE c.version_id = :version_id
     ORDER BY b.name, c.pincode
     LIMIT 2000`,
    { version_id: versionId },
  );
  return { version, rows };
}

/**
 * Super Admin only (enforced by route): activate a draft/pending version.
 */
export async function approveGeoPolicyVersion(versionId, approvedBy) {
  const pool = getPool();
  await ensureLenderGeoPolicySchema(pool);
  const [[version]] = await pool.query(
    `SELECT * FROM lender_geo_policy_versions WHERE id = :id`,
    { id: versionId },
  );
  if (!version) {
    const e = new Error('Geo policy version not found');
    e.status = 404;
    throw e;
  }
  if (version.status === 'active') {
    return version;
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `UPDATE lender_geo_policy_versions SET status = 'superseded', updated_at = NOW()
       WHERE status = 'active'`,
    );
    await conn.execute(
      `UPDATE lender_geo_policy_versions SET
         status = 'active',
         approved_by = :by,
         approved_at = NOW(),
         updated_at = NOW()
       WHERE id = :id`,
      { id: versionId, by: approvedBy || null },
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  const [[next]] = await pool.query(
    `SELECT * FROM lender_geo_policy_versions WHERE id = :id`,
    { id: versionId },
  );
  return next;
}

/**
 * Create a draft geo version from bulk sheet rows (Geo_Coverage / Location_Rules).
 * bankId resolved via lenderCode map or bank name.
 * Inserts are batched for large Location_Rules sheets (thousands of PINs).
 */
export async function createGeoVersionFromSheetRows({
  rows,
  uploadedBy,
  sourceJobId = null,
  changeReason = null,
  effectiveFrom = null,
  effectiveTo = null,
  versionLabel = null,
  lenderIdMap = {},
  conn = null,
}) {
  const pool = conn || getPool();
  if (!conn) await ensureLenderGeoPolicySchema(pool);

  const ownsConnection = !conn;
  const db = conn || (await pool.getConnection());
  const BATCH_SIZE = Math.max(50, Number(process.env.GEO_IMPORT_BATCH_SIZE || 250));

  try {
    if (ownsConnection) await db.beginTransaction();

    const versionId = newId();
    await db.execute(
      `INSERT INTO lender_geo_policy_versions (
         id, version_label, status, change_reason, effective_from, effective_to,
         source_job_id, uploaded_by
       ) VALUES (
         :id, :label, 'pending_approval', :reason, :from, :to, :job, :by
       )`,
      {
        id: versionId,
        label: versionLabel || `geo-${new Date().toISOString().slice(0, 10)}`,
        reason: changeReason || 'Bulk geo coverage upload',
        from: effectiveFrom || null,
        to: effectiveTo || null,
        job: sourceJobId || null,
        by: uploadedBy || null,
      },
    );

    // Resolve lender codes once — avoid N SELECTs for large Location_Rules sheets.
    const resolvedBanks = { ...lenderIdMap };
    const missingKeys = new Set();
    for (const raw of rows || []) {
      const lenderKey = String(
        raw.Lender_Code
          || raw.Lender_ID
          || raw.lender_code
          || raw.Bank_Code
          || raw.bank_code
          || '',
      ).trim();
      if (!lenderKey) continue;
      if (
        resolvedBanks[lenderKey]
        || resolvedBanks[lenderKey.toUpperCase()]
        || raw.bank_id
      ) {
        continue;
      }
      missingKeys.add(lenderKey);
    }
    for (const code of missingKeys) {
      const [[bank]] = await db.query(
        `SELECT id FROM banks
         WHERE UPPER(COALESCE(lender_code, '')) = UPPER(:code)
            OR UPPER(name) = UPPER(:code)
         LIMIT 1`,
        { code },
      );
      if (bank?.id) {
        resolvedBanks[code] = bank.id;
        resolvedBanks[code.toUpperCase()] = bank.id;
      }
    }

    const pending = [];
    let skippedNoBank = 0;
    for (const raw of rows || []) {
      const lenderKey = String(
        raw.Lender_Code
          || raw.Lender_ID
          || raw.lender_code
          || raw.Bank_Code
          || raw.bank_code
          || '',
      ).trim();
      const bankId =
        resolvedBanks[lenderKey]
        || resolvedBanks[lenderKey.toUpperCase()]
        || raw.bank_id
        || null;
      if (!bankId) {
        skippedNoBank += 1;
        continue;
      }

      const pin = normalizePin(
        raw.PIN_Code || raw.Serviceable_PIN || raw.Pincode || raw.pincode || raw.PIN,
      );
      const districtName = raw.District || raw.district_name || raw.District_Name || null;
      const stateName = raw.State || raw.state_name || raw.State_Name || null;
      const tehsilName = raw.Tehsil || raw.tehsil_name || null;
      const coverageType = normalizeCoverageType(
        raw.Coverage_Type || raw.Coverage || raw.Status || raw.coverage_type || 'INCLUDE',
      );
      const geoLevel = pin ? 'pincode' : districtName ? 'district' : stateName ? 'state' : 'pincode';

      pending.push({
        id: newId(),
        version_id: versionId,
        bank_id: bankId,
        geo_level: geoLevel,
        state_name: stateName,
        district_name: districtName,
        tehsil_name: tehsilName,
        pincode: pin,
        coverage_type: coverageType,
        branch_code: raw.Branch_ID || raw.Branch_Code || raw.branch_code || null,
        radius_km: raw.Radius_KM || raw.radius_km || null,
        remarks: raw.Remarks || raw.remarks || null,
        priority: pin ? 100 : districtName ? 50 : 10,
      });
    }

    let inserted = 0;
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const chunk = pending.slice(i, i + BATCH_SIZE);
      // Build one multi-row INSERT per batch (named params per row).
      const valuesSql = chunk
        .map(
          (_row, idx) =>
            `(:id_${idx}, :version_id_${idx}, :bank_id_${idx}, :geo_level_${idx}, :state_name_${idx}, :district_name_${idx}, :tehsil_name_${idx}, :pincode_${idx}, :coverage_type_${idx}, :branch_code_${idx}, :radius_km_${idx}, :remarks_${idx}, :priority_${idx})`,
        )
        .join(',\n');
      const params = {};
      chunk.forEach((row, idx) => {
        params[`id_${idx}`] = row.id;
        params[`version_id_${idx}`] = row.version_id;
        params[`bank_id_${idx}`] = row.bank_id;
        params[`geo_level_${idx}`] = row.geo_level;
        params[`state_name_${idx}`] = row.state_name;
        params[`district_name_${idx}`] = row.district_name;
        params[`tehsil_name_${idx}`] = row.tehsil_name;
        params[`pincode_${idx}`] = row.pincode;
        params[`coverage_type_${idx}`] = row.coverage_type;
        params[`branch_code_${idx}`] = row.branch_code;
        params[`radius_km_${idx}`] = row.radius_km;
        params[`remarks_${idx}`] = row.remarks;
        params[`priority_${idx}`] = row.priority;
      });
      await db.execute(
        `INSERT INTO lender_geo_coverage (
           id, version_id, bank_id, geo_level, state_name, district_name, tehsil_name,
           pincode, coverage_type, branch_code, radius_km, remarks, priority
         ) VALUES ${valuesSql}`,
        params,
      );
      inserted += chunk.length;
    }

    if (ownsConnection) await db.commit();
    return {
      versionId,
      inserted,
      skippedNoBank,
      status: 'pending_approval',
    };
  } catch (err) {
    if (ownsConnection) await db.rollback();
    throw err;
  } finally {
    if (ownsConnection) db.release();
  }
}
