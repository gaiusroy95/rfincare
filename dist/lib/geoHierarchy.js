import { getPool } from "../db/pool.js";
import { newId } from "./ids.js";
let schemaReady = false;
async function ensureGeoSchema(pool = getPool()) {
  if (schemaReady) return;
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS geo_districts (
      id CHAR(36) NOT NULL PRIMARY KEY,
      state_id CHAR(36) NOT NULL,
      name VARCHAR(128) NOT NULL,
      code VARCHAR(32) NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS geo_cities (
      id CHAR(36) NOT NULL PRIMARY KEY,
      district_id CHAR(36) NOT NULL,
      name VARCHAR(128) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS geo_tehsils (
      id CHAR(36) NOT NULL PRIMARY KEY,
      city_id CHAR(36) NULL,
      district_id CHAR(36) NOT NULL,
      name VARCHAR(128) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS geo_villages (
      id CHAR(36) NOT NULL PRIMARY KEY,
      tehsil_id CHAR(36) NULL,
      district_id CHAR(36) NOT NULL,
      name VARCHAR(128) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS geo_pincodes (
      id CHAR(36) NOT NULL PRIMARY KEY,
      pincode VARCHAR(10) NOT NULL,
      state_id CHAR(36) NULL,
      district_id CHAR(36) NULL,
      city_id CHAR(36) NULL,
      tehsil_id CHAR(36) NULL,
      village_id CHAR(36) NULL,
      locality VARCHAR(255) NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS lender_serviceability (
      id CHAR(36) NOT NULL PRIMARY KEY,
      bank_id CHAR(36) NOT NULL,
      bank_product_id CHAR(36) NULL,
      level VARCHAR(32) NOT NULL DEFAULT 'pincode',
      ref_id CHAR(36) NULL,
      pincode VARCHAR(10) NULL,
      state_id CHAR(36) NULL,
      district_id CHAR(36) NULL,
      city_id CHAR(36) NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'serviceable',
      notes TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  schemaReady = true;
}
async function listDistricts(stateId) {
  await ensureGeoSchema();
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT id, state_id, name, code, is_active FROM geo_districts
     WHERE state_id = :state_id AND is_active = TRUE ORDER BY name`,
    { state_id: stateId }
  );
  return rows;
}
async function listCities(districtId) {
  await ensureGeoSchema();
  const pool = getPool();
  const [rows] = await pool.query(
    `SELECT id, district_id, name, is_active FROM geo_cities
     WHERE district_id = :district_id AND is_active = TRUE ORDER BY name`,
    { district_id: districtId }
  );
  return rows;
}
async function listTehsils({ districtId, cityId } = {}) {
  await ensureGeoSchema();
  const pool = getPool();
  const clauses = ["is_active = TRUE"];
  const params = {};
  if (districtId) {
    clauses.push("district_id = :district_id");
    params.district_id = districtId;
  }
  if (cityId) {
    clauses.push("city_id = :city_id");
    params.city_id = cityId;
  }
  const [rows] = await pool.query(
    `SELECT id, district_id, city_id, name FROM geo_tehsils
     WHERE ${clauses.join(" AND ")} ORDER BY name LIMIT 500`,
    params
  );
  return rows;
}
async function listVillages({ districtId, tehsilId } = {}) {
  await ensureGeoSchema();
  const pool = getPool();
  const clauses = ["is_active = TRUE"];
  const params = {};
  if (districtId) {
    clauses.push("district_id = :district_id");
    params.district_id = districtId;
  }
  if (tehsilId) {
    clauses.push("tehsil_id = :tehsil_id");
    params.tehsil_id = tehsilId;
  }
  const [rows] = await pool.query(
    `SELECT id, district_id, tehsil_id, name FROM geo_villages
     WHERE ${clauses.join(" AND ")} ORDER BY name LIMIT 500`,
    params
  );
  return rows;
}
async function lookupPincode(pincode) {
  await ensureGeoSchema();
  const pool = getPool();
  const pin = String(pincode || "").trim();
  const [rows] = await pool.query(
    `SELECT p.*, s.state_name, d.name AS district_name, c.name AS city_name,
            t.name AS tehsil_name, v.name AS village_name
     FROM geo_pincodes p
     LEFT JOIN indian_states s ON s.id = p.state_id
     LEFT JOIN geo_districts d ON d.id = p.district_id
     LEFT JOIN geo_cities c ON c.id = p.city_id
     LEFT JOIN geo_tehsils t ON t.id = p.tehsil_id
     LEFT JOIN geo_villages v ON v.id = p.village_id
     WHERE p.pincode = :pin AND p.is_active = TRUE
     LIMIT 5`,
    { pin }
  );
  return rows;
}
async function createGeoNode(level, payload) {
  await ensureGeoSchema();
  const pool = getPool();
  const id = newId();
  if (level === "district") {
    await pool.execute(
      `INSERT INTO geo_districts (id, state_id, name, code) VALUES (:id, :state_id, :name, :code)`,
      { id, state_id: payload.stateId, name: payload.name, code: payload.code || null }
    );
  } else if (level === "city") {
    await pool.execute(
      `INSERT INTO geo_cities (id, district_id, name) VALUES (:id, :district_id, :name)`,
      { id, district_id: payload.districtId, name: payload.name }
    );
  } else if (level === "tehsil") {
    await pool.execute(
      `INSERT INTO geo_tehsils (id, district_id, city_id, name)
       VALUES (:id, :district_id, :city_id, :name)`,
      {
        id,
        district_id: payload.districtId,
        city_id: payload.cityId || null,
        name: payload.name
      }
    );
  } else if (level === "village") {
    await pool.execute(
      `INSERT INTO geo_villages (id, district_id, tehsil_id, name)
       VALUES (:id, :district_id, :tehsil_id, :name)`,
      {
        id,
        district_id: payload.districtId,
        tehsil_id: payload.tehsilId || null,
        name: payload.name
      }
    );
  } else if (level === "pincode") {
    await pool.execute(
      `INSERT INTO geo_pincodes (
         id, pincode, state_id, district_id, city_id, tehsil_id, village_id, locality
       ) VALUES (
         :id, :pincode, :state_id, :district_id, :city_id, :tehsil_id, :village_id, :locality
       )`,
      {
        id,
        pincode: String(payload.pincode).trim(),
        state_id: payload.stateId || null,
        district_id: payload.districtId || null,
        city_id: payload.cityId || null,
        tehsil_id: payload.tehsilId || null,
        village_id: payload.villageId || null,
        locality: payload.locality || null
      }
    );
  } else {
    const e = new Error(`Unknown geo level: ${level}`);
    e.status = 400;
    throw e;
  }
  return id;
}
async function listServiceability({ bankId } = {}) {
  await ensureGeoSchema();
  const pool = getPool();
  if (bankId) {
    const [rows2] = await pool.query(
      `SELECT * FROM lender_serviceability WHERE bank_id = :bank_id ORDER BY updated_at DESC LIMIT 500`,
      { bank_id: bankId }
    );
    return rows2;
  }
  const [rows] = await pool.query(
    `SELECT * FROM lender_serviceability ORDER BY updated_at DESC LIMIT 500`
  );
  return rows;
}
async function upsertServiceability(row, actorId = null) {
  await ensureGeoSchema();
  const pool = getPool();
  const status = row.status || "serviceable";
  const notes = row.notes || null;
  const bankId = row.bankId || row.bank_id;
  const pincode = row.pincode || null;
  const bankProductId = row.bankProductId || row.bank_product_id || null;
  const level = row.level || "pincode";
  if (row.id) {
    await pool.execute(
      `UPDATE lender_serviceability SET
         status = :status, notes = :notes, updated_at = NOW()
       WHERE id = :id`,
      { id: row.id, status, notes }
    );
    return row.id;
  }
  if (bankId && pincode && level === "pincode") {
    let existing = null;
    if (bankProductId) {
      const [[found]] = await pool.query(
        `SELECT id FROM lender_serviceability
         WHERE bank_id = :bank_id AND pincode = :pincode AND level = 'pincode'
           AND bank_product_id = :bank_product_id
         LIMIT 1`,
        { bank_id: bankId, pincode, bank_product_id: bankProductId }
      );
      existing = found;
    } else {
      const [[found]] = await pool.query(
        `SELECT id FROM lender_serviceability
         WHERE bank_id = :bank_id AND pincode = :pincode AND level = 'pincode'
           AND bank_product_id IS NULL
         LIMIT 1`,
        { bank_id: bankId, pincode }
      );
      existing = found;
    }
    if (existing?.id) {
      await pool.execute(
        `UPDATE lender_serviceability SET
           status = :status, notes = :notes, updated_at = NOW()
         WHERE id = :id`,
        { id: existing.id, status, notes }
      );
      return existing.id;
    }
  }
  const id = newId();
  await pool.execute(
    `INSERT INTO lender_serviceability (
       id, bank_id, bank_product_id, level, ref_id, pincode,
       state_id, district_id, city_id, status, notes
     ) VALUES (
       :id, :bank_id, :bank_product_id, :level, :ref_id, :pincode,
       :state_id, :district_id, :city_id, :status, :notes
     )`,
    {
      id,
      bank_id: bankId,
      bank_product_id: bankProductId,
      level,
      ref_id: row.refId || null,
      pincode,
      state_id: row.stateId || null,
      district_id: row.districtId || null,
      city_id: row.cityId || null,
      status,
      notes
    }
  );
  return id;
}
async function seedDemoGeoIfEmpty() {
  await ensureGeoSchema();
  const pool = getPool();
  const [[countRow]] = await pool.query(`SELECT COUNT(*)::int AS c FROM geo_districts`);
  if (Number(countRow?.c || 0) > 0) return { seeded: false };
  const [states] = await pool.query(
    `SELECT id, state_name FROM indian_states WHERE state_name IN ('Maharashtra','Karnataka','Delhi','Tamil Nadu','Gujarat')`
  );
  const byName = Object.fromEntries(states.map((s) => [s.state_name, s.id]));
  const demo = [
    {
      state: "Maharashtra",
      districts: [
        {
          name: "Mumbai Suburban",
          cities: [
            {
              name: "Mumbai",
              tehsils: [{ name: "Andheri", villages: ["Versova"], pins: ["400053", "400058"] }]
            }
          ]
        },
        {
          name: "Pune",
          cities: [
            {
              name: "Pune",
              tehsils: [{ name: "Haveli", villages: ["Kharadi"], pins: ["411014", "411001"] }]
            }
          ]
        }
      ]
    },
    {
      state: "Karnataka",
      districts: [
        {
          name: "Bengaluru Urban",
          cities: [
            {
              name: "Bengaluru",
              tehsils: [{ name: "Bangalore North", villages: ["Yelahanka"], pins: ["560064", "560001"] }]
            }
          ]
        }
      ]
    },
    {
      state: "Delhi",
      districts: [
        {
          name: "New Delhi",
          cities: [
            {
              name: "New Delhi",
              tehsils: [{ name: "Connaught Place", villages: ["Central Delhi"], pins: ["110001"] }]
            }
          ]
        }
      ]
    }
  ];
  for (const block of demo) {
    const stateId = byName[block.state];
    if (!stateId) continue;
    for (const dist of block.districts) {
      const districtId = newId();
      await pool.execute(
        `INSERT INTO geo_districts (id, state_id, name) VALUES (:id, :state_id, :name)`,
        { id: districtId, state_id: stateId, name: dist.name }
      );
      for (const city of dist.cities) {
        const cityId = newId();
        await pool.execute(
          `INSERT INTO geo_cities (id, district_id, name) VALUES (:id, :district_id, :name)`,
          { id: cityId, district_id: districtId, name: city.name }
        );
        for (const tehsil of city.tehsils || []) {
          const tehsilId = newId();
          await pool.execute(
            `INSERT INTO geo_tehsils (id, district_id, city_id, name)
             VALUES (:id, :district_id, :city_id, :name)`,
            { id: tehsilId, district_id: districtId, city_id: cityId, name: tehsil.name }
          );
          for (const village of tehsil.villages || []) {
            const villageId = newId();
            await pool.execute(
              `INSERT INTO geo_villages (id, district_id, tehsil_id, name)
               VALUES (:id, :district_id, :tehsil_id, :name)`,
              { id: villageId, district_id: districtId, tehsil_id: tehsilId, name: village }
            );
            for (const pin of tehsil.pins || []) {
              await pool.execute(
                `INSERT INTO geo_pincodes (
                   id, pincode, state_id, district_id, city_id, tehsil_id, village_id, locality
                 ) VALUES (
                   :id, :pincode, :state_id, :district_id, :city_id, :tehsil_id, :village_id, :locality
                 )`,
                {
                  id: newId(),
                  pincode: pin,
                  state_id: stateId,
                  district_id: districtId,
                  city_id: cityId,
                  tehsil_id: tehsilId,
                  village_id: villageId,
                  locality: village
                }
              );
            }
          }
        }
      }
    }
  }
  return { seeded: true };
}
export {
  createGeoNode,
  ensureGeoSchema,
  listCities,
  listDistricts,
  listServiceability,
  listTehsils,
  listVillages,
  lookupPincode,
  seedDemoGeoIfEmpty,
  upsertServiceability
};
