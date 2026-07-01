/**
 * Named (:param) and positional (?) parameter binding for PostgreSQL.
 * Coerces MySQL-style 0/1 values into booleans for boolean columns.
 */

const NAMED_PARAM_RE = /(^|[^:]):([a-zA-Z_][a-zA-Z0-9_]*)/g;

/** PostgreSQL BOOLEAN columns (snake_case). */
const BOOL_COLUMNS = new Set([
  'consent_accepted',
  'dining_benefits',
  'emi_conversion',
  'enabled',
  'fuel_surcharge_waiver',
  'ga_enabled',
  'insurance_cover',
  'is_active',
  'is_granted',
  'is_new',
  'is_primary',
  'is_published',
  'is_read',
  'is_required',
  'is_verified',
  'lounge_access',
  'meta_pixel_enabled',
  'movie_benefits',
  'password_change_required',
  'require_applied_customer_email',
  'require_email_otp',
  'require_mobile_otp',
  'require_whatsapp_otp',
  'sandbox_mode',
  'supports_claim_assistance',
  'supports_lumpsum',
  'supports_new_policy',
  'supports_renewal',
  'supports_sip',
  'tax_benefit_80c',
  'tax_benefit_80d',
]);

/** Named params that map to boolean columns but are not snake_case column names. */
const BOOL_ALIASES = new Set([
  'active',
  'pub',
  'req_email',
  'req_mobile',
  'req_whatsapp',
  'require_email',
  'sandbox',
]);

/** Named params (camelCase) used in marketplace INSERT/UPDATE bindings. */
const CAMEL_BOOL_PARAMS = new Set([
  'diningBenefits',
  'emiConversion',
  'fuelSurchargeWaiver',
  'insuranceCover',
  'loungeAccess',
  'movieBenefits',
  'supportsClaimAssistance',
  'supportsLumpsum',
  'supportsNewPolicy',
  'supportsRenewal',
  'supportsSip',
  'taxBenefit80c',
  'taxBenefit80d',
]);

/**
 * Params compared to integers in CASE/WHEN (e.g. WHEN :locked = 1).
 * These must stay as 0/1 integers, not booleans.
 */
const INT_FLAG_PARAMS = new Set([
  'can_edit_qc_identity',
  'locked',
  'mark_reviewed',
  'set_qc_admin_auto',
  'set_qc_employee_auto',
  'set_qc_updated',
]);

const PG_BOOLEAN_COLUMNS = [...BOOL_COLUMNS];

function toSnakeCase(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

export function isBooleanParam(name) {
  const raw = String(name || '');
  const n = raw.toLowerCase();
  const snake = toSnakeCase(raw);
  if (!raw || INT_FLAG_PARAMS.has(n) || INT_FLAG_PARAMS.has(snake)) return false;
  if (CAMEL_BOOL_PARAMS.has(raw)) return true;
  if (BOOL_COLUMNS.has(n) || BOOL_COLUMNS.has(snake)) return true;
  if (BOOL_ALIASES.has(n)) return true;
  if (snake.startsWith('supports_') || snake.startsWith('tax_benefit_')) return true;
  if (n.startsWith('supports_') || n.startsWith('tax_benefit_')) return true;
  if (n.startsWith('is_') || n.startsWith('has_') || snake.startsWith('is_') || snake.startsWith('has_')) {
    return true;
  }
  if (n.startsWith('require_') || snake.startsWith('require_')) return true;
  if (/^supports[A-Z]/.test(raw) || /^taxBenefit/.test(raw)) return true;
  if (
    n.endsWith('_enabled')
    || n.endsWith('_active')
    || n.endsWith('_waiver')
    || n.endsWith('_cover')
    || n.endsWith('_benefits')
    || n.endsWith('_conversion')
    || n.endsWith('_access')
    || /(?:Benefits|Waiver|Cover|Access|Conversion)$/.test(raw)
  ) {
    return true;
  }
  return false;
}

function coerceValue(name, value) {
  if (!isBooleanParam(name)) return value;
  if (value === null || value === undefined) return value;
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return Boolean(value);
  if (value === '0' || value === '1') return value === '1';
  if (value === 'true' || value === 'false') return value === 'true';
  return value;
}

/**
 * Rewrite MySQL-style boolean literals in SQL (column = 0/1) for PostgreSQL.
 */
export function normalizeBooleanSqlLiterals(sql) {
  let s = String(sql || '');

  for (const col of PG_BOOLEAN_COLUMNS) {
    const escaped = col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`\\b${escaped}\\s*=\\s*1\\b`, 'gi'), `${col} = TRUE`);
    s = s.replace(new RegExp(`\\b${escaped}\\s*=\\s*0\\b`, 'gi'), `${col} = FALSE`);
  }

  // user_profiles INSERT: ..., 'active', 1)
  s = s.replace(/'active'\s*,\s*1(\s*\))/gi, "'active', TRUE$1");

  // bank_products INSERT: ..., 1, :data) where 1 is is_active
  s = s.replace(
    /(INSERT\s+INTO\s+bank_products\s*\([^)]*is_active[^)]*\)\s*VALUES\s*\([^,]+,[^,]+,[^,]+,\s*)1(\s*,\s*:)/gi,
    '$1TRUE$2',
  );

  // customer_notifications INSERT: ..., 0) for is_read
  s = s.replace(
    /(INSERT\s+INTO\s+customer_notifications\s*\([^)]*is_read[^)]*\)\s*VALUES\s*\([^)]*,\s*)0(\s*\))/gi,
    '$1FALSE$2',
  );

  // document_requirements bulk import: ..., 1, :sort_order, 1, :created_by
  s = s.replace(
    /:allowed_file_types_json\s*,\s*1\s*,\s*:sort_order\s*,\s*1\s*,/gi,
    ':allowed_file_types_json, TRUE, :sort_order, TRUE,',
  );

  // loan_product_catalog INSERT: ..., :sort_order, 1)
  s = s.replace(
    /:sort_order\s*,\s*1(\s*\))/gi,
    ':sort_order, TRUE$1',
  );

  return s;
}

export function prepareQuery(sql, params) {
  const normalizedSql = normalizeBooleanSqlLiterals(sql);
  if (Array.isArray(params)) {
    return convertPositionalParams(normalizedSql, params);
  }
  return convertNamedParams(normalizedSql, params || {});
}

export function convertNamedParams(sql, params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { text: sql, values: [] };
  }

  const order = [];
  const indexByName = new Map();

  const text = sql.replace(NAMED_PARAM_RE, (_match, prefix, name) => {
    if (!indexByName.has(name)) {
      indexByName.set(name, order.length + 1);
      order.push(name);
    }
    return `${prefix}$${indexByName.get(name)}`;
  });

  const values = order.map((name) => coerceValue(name, params[name]));
  return { text, values };
}

export function convertPositionalParams(sql, values = []) {
  let index = 0;
  const text = sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
  return { text, values };
}
