/**
 * Named (:param) and positional (?) parameter binding for PostgreSQL.
 */

const NAMED_PARAM_RE = /(^|[^:]):([a-zA-Z_][a-zA-Z0-9_]*)/g;

const BOOL_COLUMNS = new Set([
  'ga_enabled',
  'meta_pixel_enabled',
  'sandbox_mode',
  'enabled',
  'active',
  'is_active',
  'is_new',
  'is_required',
  'is_primary',
  'require_mobile_otp',
  'require_email_otp',
  'require_whatsapp_otp',
  'require_applied_customer_email',
  'consent_accepted',
  'locked',
  'req_mobile',
  'req_email',
  'req_whatsapp',
]);

export function isBooleanParam(name) {
  const n = String(name || '').toLowerCase();
  if (BOOL_COLUMNS.has(n)) return true;
  if (n.startsWith('is_') || n.startsWith('has_') || n.startsWith('require_')) return true;
  if (n.endsWith('_enabled') || n.endsWith('_active')) return true;
  return false;
}

function coerceValue(name, value) {
  if (!isBooleanParam(name)) return value;
  if (value === 0 || value === 1) return Boolean(value);
  if (value === '0' || value === '1') return value === '1';
  return value;
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
