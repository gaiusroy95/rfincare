import { getPool } from '../db/pool.js';
import { isIgnorableEnsureError } from '../db/schemaErrors.js';

/**
 * Which credit bureau to pull for a check: a default bureau plus optional per-loan-product
 * overrides (Admin → API Configuration → Bureau routing).
 * Client requirement (2026-11-25): Experian by default; Business Loan → CRIF High Mark.
 */

export const ROUTABLE_BUREAUS = ['experian', 'transunion_cibil', 'crif_high_mark'];

export const DEFAULT_BUREAU_ROUTING = Object.freeze({
  defaultBureau: 'experian',
  byProduct: { business_loan: 'crif_high_mark' },
});

const CACHE_MS = 30_000;
let cache = null;
let cacheAt = 0;
let schemaReady = false;

async function ensureRoutingSchema(pool) {
  if (schemaReady) return;
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS cibil_bureau_routing (
        id SMALLINT NOT NULL DEFAULT 1,
        default_bureau VARCHAR(32) NOT NULL DEFAULT 'experian',
        product_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_by CHAR(36) NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
    `);
  } catch (err) {
    if (!isIgnorableEnsureError(err)) throw err;
  }
  schemaReady = true;
}

/** "Business Loan", "business-loan", "business_loan" → "business_loan". */
export function normalizeProductKey(raw) {
  const key = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  if (!key) return '';
  return key.endsWith('_loan') || key.includes('_') ? key : `${key}_loan`;
}

function sanitize(input = {}) {
  const defaultBureau = ROUTABLE_BUREAUS.includes(input.defaultBureau)
    ? input.defaultBureau
    : DEFAULT_BUREAU_ROUTING.defaultBureau;
  const byProduct = {};
  for (const [product, bureau] of Object.entries(input.byProduct || {})) {
    const key = normalizeProductKey(product);
    if (key && ROUTABLE_BUREAUS.includes(bureau) && bureau !== defaultBureau) byProduct[key] = bureau;
  }
  return { defaultBureau, byProduct };
}

export async function getBureauRouting(pool = getPool()) {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
  await ensureRoutingSchema(pool);
  let routing = { ...DEFAULT_BUREAU_ROUTING, byProduct: { ...DEFAULT_BUREAU_ROUTING.byProduct } };
  try {
    const [[row]] = await pool.execute(
      `SELECT default_bureau, product_overrides, updated_at FROM cibil_bureau_routing WHERE id = 1 LIMIT 1`,
    );
    if (row) {
      const overrides = typeof row.product_overrides === 'string'
        ? JSON.parse(row.product_overrides || '{}')
        : row.product_overrides || {};
      routing = { ...sanitize({ defaultBureau: row.default_bureau, byProduct: overrides }), updatedAt: row.updated_at };
    }
  } catch (err) {
    if (!isIgnorableEnsureError(err)) throw err;
  }
  cache = routing;
  cacheAt = Date.now();
  return routing;
}

export async function saveBureauRouting(input, updatedBy = null, pool = getPool()) {
  await ensureRoutingSchema(pool);
  const clean = sanitize(input);
  await pool.execute(
    `INSERT INTO cibil_bureau_routing (id, default_bureau, product_overrides, updated_by, updated_at)
     VALUES (1, :default_bureau, CAST(:overrides AS JSONB), :updated_by, NOW())
     ON CONFLICT (id) DO UPDATE SET
       default_bureau = EXCLUDED.default_bureau,
       product_overrides = EXCLUDED.product_overrides,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    {
      default_bureau: clean.defaultBureau,
      overrides: JSON.stringify(clean.byProduct),
      updated_by: updatedBy,
    },
  );
  cache = null;
  return getBureauRouting(pool);
}

/** Bureau for a check; `productKey` is the loan product when known (else the default). */
export async function resolveBureauKey({ productKey = null } = {}, pool = getPool()) {
  const routing = await getBureauRouting(pool);
  const key = normalizeProductKey(productKey);
  return (key && routing.byProduct[key]) || routing.defaultBureau;
}

/** Loan product of an application row (data JSON). */
export function applicationProductKey(application) {
  let data = application?.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      data = {};
    }
  }
  data = data || {};
  return data.loan_type || data.loanType || data.loan_purpose || data.loanPurpose || null;
}

export function resetBureauRoutingCacheForTests() {
  cache = null;
  cacheAt = 0;
}
