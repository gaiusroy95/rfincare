import * as XLSX from 'xlsx';

import { getPool } from '../db/pool.js';
import { newId } from './ids.js';
import { ensureGeoSchema } from './geoHierarchy.js';

const VALID_STATUS = new Set(['serviceable', 'restricted', 'not_serviceable']);

function normalizeKey(key) {
  return String(key || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function sheetToRows(buffer, filename = '') {
  const name = String(filename).toLowerCase();
  if (name.endsWith('.csv')) {
    const text = buffer.toString('utf8');
    const wb = XLSX.read(text, { type: 'string' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { defval: '' });
  }
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

function normalizeRow(raw) {
  const row = {};
  for (const [k, v] of Object.entries(raw || {})) {
    row[normalizeKey(k)] = typeof v === 'string' ? v.trim() : v;
  }
  return {
    pincode: String(row.pincode || row.pin || row.pin_code || '').replace(/\D/g, '').slice(0, 6),
    status: String(row.status || row.serviceability || 'serviceable').toLowerCase().replace(/\s+/g, '_'),
    notes: row.notes || row.note || row.remarks || '',
    productId: String(row.product_id || row.bank_product_id || row.productid || row.product || '').trim(),
    state: row.state || row.state_name || '',
    district: row.district || row.district_name || '',
    city: row.city || row.city_name || '',
    locality: row.locality || row.area || '',
  };
}

export function buildServiceabilityTemplateWorkbook() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['Lender serviceability upload — one file per bank (PIN-wise area mapping in one go)'],
      ['Required columns: Pincode, Status'],
      ['Optional: Product_ID (bank product UUID or product name) for product-wise coverage'],
      ['Status values: serviceable | restricted | not_serviceable'],
      ['Eligibility uses this list: serviceable/restricted → "location is mapped"; else → "location not covered by bank"'],
      [],
      ['Pincode', 'Status', 'Notes', 'Product_ID', 'State', 'District', 'City', 'Locality'],
      ['400001', 'serviceable', 'Mumbai central', '', 'Maharashtra', 'Mumbai', 'Mumbai', 'Fort'],
      ['400053', 'serviceable', '', '', 'Maharashtra', 'Mumbai Suburban', 'Mumbai', 'Andheri West'],
      ['110001', 'restricted', 'Special approval', '', 'Delhi', 'New Delhi', 'New Delhi', 'Connaught Place'],
    ]),
    'Serviceability',
  );
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export function parseServiceabilityUpload(buffer, filename) {
  const rawRows = sheetToRows(buffer, filename);
  const errors = [];
  const rows = [];

  rawRows.forEach((raw, idx) => {
    const rowNum = idx + 2;
    const keys = Object.keys(raw || {}).map(normalizeKey);
    const hasPin = keys.some((k) => ['pincode', 'pin', 'pin_code'].includes(k));
    if (!hasPin && !raw?.Pincode && !raw?.PIN) {
      if (idx === 0 && String(raw?.[Object.keys(raw)[0]] || '').includes('Lender serviceability')) return;
      if (!Object.values(raw || {}).some((v) => String(v || '').trim())) return;
    }

    const row = normalizeRow(raw);
    if (!row.pincode || row.pincode.length !== 6) {
      errors.push({ row: rowNum, message: 'Pincode must be 6 digits' });
      return;
    }
    if (!VALID_STATUS.has(row.status)) {
      errors.push({
        row: rowNum,
        message: `Invalid status "${row.status}". Use serviceable, restricted, or not_serviceable`,
      });
      return;
    }
    rows.push(row);
  });

  if (!rows.length && !errors.length) {
    errors.push({ row: 0, message: 'No data rows found. Use columns Pincode and Status.' });
  }

  return { rows, errors, valid: errors.length === 0 && rows.length > 0 };
}

export async function importServiceabilityForBank({ bankId, rows, replaceExisting = false }) {
  await ensureGeoSchema();
  const pool = getPool();

  const [[bank]] = await pool.query(`SELECT id, name FROM banks WHERE id = :id`, { id: bankId });
  if (!bank) {
    const e = new Error('Bank not found');
    e.status = 404;
    throw e;
  }

  if (replaceExisting) {
    await pool.execute(`DELETE FROM lender_serviceability WHERE bank_id = :bank_id`, { bank_id: bankId });
  }

  const [products] = await pool.query(
    `SELECT id, name FROM bank_products WHERE bank_id = :bank_id AND is_active = TRUE`,
    { bank_id: bankId },
  );
  const productById = new Map(products.map((p) => [String(p.id), p.id]));
  const productByName = new Map(
    products.map((p) => [String(p.name || '').trim().toLowerCase(), p.id]),
  );

  function resolveProductId(raw) {
    if (!raw) return null;
    if (productById.has(raw)) return productById.get(raw);
    const byName = productByName.get(String(raw).toLowerCase());
    return byName || null;
  }

  let created = 0;
  let updated = 0;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const row of rows) {
      const bankProductId = resolveProductId(row.productId);
      let existing = null;
      if (bankProductId) {
        const [[rowMatch]] = await conn.query(
          `SELECT id FROM lender_serviceability
           WHERE bank_id = :bank_id AND pincode = :pincode AND level = 'pincode'
             AND bank_product_id = :bank_product_id
           LIMIT 1`,
          { bank_id: bankId, pincode: row.pincode, bank_product_id: bankProductId },
        );
        existing = rowMatch;
      } else {
        const [[rowMatch]] = await conn.query(
          `SELECT id FROM lender_serviceability
           WHERE bank_id = :bank_id AND pincode = :pincode AND level = 'pincode'
             AND bank_product_id IS NULL
           LIMIT 1`,
          { bank_id: bankId, pincode: row.pincode },
        );
        existing = rowMatch;
      }
      const notesParts = [
        row.notes,
        row.state || row.district || row.city || row.locality
          ? [row.locality, row.city, row.district, row.state].filter(Boolean).join(', ')
          : '',
      ].filter(Boolean);
      const notes = notesParts.join(' | ') || null;

      if (existing?.id) {
        await conn.execute(
          `UPDATE lender_serviceability SET
             status = :status, notes = :notes, bank_product_id = :bank_product_id, updated_at = NOW()
           WHERE id = :id`,
          {
            id: existing.id,
            status: row.status,
            notes,
            bank_product_id: bankProductId,
          },
        );
        updated += 1;
      } else {
        const id = newId();
        await conn.execute(
          `INSERT INTO lender_serviceability (
             id, bank_id, bank_product_id, level, pincode, status, notes
           ) VALUES (
             :id, :bank_id, :bank_product_id, 'pincode', :pincode, :status, :notes
           )`,
          {
            id,
            bank_id: bankId,
            bank_product_id: bankProductId,
            pincode: row.pincode,
            status: row.status,
            notes,
          },
        );
        created += 1;
      }
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return {
    bankId,
    bankName: bank.name,
    totalRows: rows.length,
    created,
    updated,
    replaced: Boolean(replaceExisting),
  };
}
