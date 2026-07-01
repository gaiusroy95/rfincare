/**
 * Adapt MySQL-oriented SQL and parameters for PostgreSQL (Neon).
 */

const NAMED_PARAM_RE = /(^|[^:]):([a-zA-Z_][a-zA-Z0-9_]*)/g;

/** Unique constraint targets for ON CONFLICT (Postgres migrations). */
const TABLE_CONFLICT_COLUMNS = {
  legal_pages: 'slug',
  oauth_provider_config: 'provider',
  cibil_vendors: 'vendor_key',
  push_device_tokens: 'expo_push_token',
  employee_access_controls: 'employee_user_id, module_name',
  agent_learning_progress: 'agent_user_id, content_id',
  employee_learning_progress: 'employee_user_id, content_id',
  marketing_settings: 'id',
  translation_cache: 'target_lang, source_hash, source_lang',
  site_contact_settings: 'id',
  otp_provider_settings: 'id',
  homepage_trust_content: 'id',
  about_page_content: 'id',
  resume_tokens: 'token_hash',
};

const MYSQL_DATE_FORMAT_TO_PG = {
  '%b': 'Mon',
  '%Y-%m': 'YYYY-MM',
  '%Y-%m-%d': 'YYYY-MM-DD',
  '%d/%m/%Y': 'DD/MM/YYYY',
  '%H:%i:%s': 'HH24:MI:SS',
};

const EXPLICIT_BOOL_COLUMNS = new Set([
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
]);

export function isBooleanColumnName(name) {
  const n = String(name || '')
    .replace(/[`"]/g, '')
    .toLowerCase();
  if (EXPLICIT_BOOL_COLUMNS.has(n)) return true;
  if (n.startsWith('is_') || n.startsWith('has_') || n.startsWith('require_')) return true;
  if (n.endsWith('_enabled') || n.endsWith('_active')) return true;
  return false;
}

export function coerceParamForPostgres(name, value) {
  if (!isBooleanColumnName(name)) return value;
  if (value === 0 || value === 1) return Boolean(value);
  if (value === '0' || value === '1') return value === '1';
  return value;
}

function convertBooleanAssignmentLiterals(sql) {
  return sql.replace(
    /\b([a-z_][a-z0-9_]*)\s*=\s*\b([01])\b(?!\d)/gi,
    (match, col, bit) => {
      if (!isBooleanColumnName(col)) return match;
      return `${col} = ${bit === '1' ? 'TRUE' : 'FALSE'}`;
    },
  );
}

function convertInsertBooleanLiterals(sql) {
  return sql.replace(
    /INSERT\s+INTO\s+[`"]?(\w+)[`"]?\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gi,
    (full, _table, colsPart, valsPart) => {
      const cols = colsPart.split(',').map((c) => c.trim().replace(/[`"]/g, ''));
      const vals = valsPart.split(',').map((v) => v.trim());
      if (cols.length !== vals.length) return full;
      const newVals = vals.map((v, i) => {
        if (!isBooleanColumnName(cols[i])) return v;
        if (v === '0') return 'FALSE';
        if (v === '1') return 'TRUE';
        return v;
      });
      return full.replace(valsPart, newVals.join(', '));
    },
  );
}

export function convertNamedParams(sql, params = {}, { coerceBooleans = false } = {}) {
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

  const values = order.map((name) => {
    const value = params[name];
    return coerceBooleans ? coerceParamForPostgres(name, value) : value;
  });
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

function inferConflictTarget(table, columnsSql) {
  if (TABLE_CONFLICT_COLUMNS[table]) {
    return TABLE_CONFLICT_COLUMNS[table];
  }

  const cols = columnsSql
    .split(',')
    .map((c) => c.trim().replace(/[`"]/g, ''))
    .filter(Boolean);

  if (cols.includes('slug')) return 'slug';
  if (cols.includes('provider')) return 'provider';
  if (cols.includes('vendor_key')) return 'vendor_key';
  if (cols.includes('expo_push_token')) return 'expo_push_token';
  if (cols.includes('token_hash')) return 'token_hash';
  if (cols[0] === 'id') return 'id';
  return 'id';
}

function convertInsertIgnore(sql) {
  if (!/INSERT\s+IGNORE\b/i.test(sql)) return sql;
  if (/ON\s+CONFLICT\b/i.test(sql)) {
    return sql.replace(/INSERT\s+IGNORE\s+/gi, 'INSERT ');
  }

  const insertMatch = sql.match(/INSERT\s+IGNORE\s+INTO\s+([`"]?\w+[`"]?)\s*\(([^)]+)\)/i);
  if (!insertMatch) {
    return sql.replace(/INSERT\s+IGNORE\s+/gi, 'INSERT ');
  }

  const table = insertMatch[1].replace(/[`"]/g, '');
  const conflictTarget = inferConflictTarget(table, insertMatch[2]);
  const withoutIgnore = sql.replace(/INSERT\s+IGNORE\s+/gi, 'INSERT ').replace(/;?\s*$/, '');
  return `${withoutIgnore} ON CONFLICT (${conflictTarget}) DO NOTHING`;
}

function convertOnDuplicateKeyUpdate(sql) {
  if (!/ON\s+DUPLICATE\s+KEY\s+UPDATE/i.test(sql)) return sql;

  let s = sql.replace(/INSERT\s+IGNORE\s+/gi, 'INSERT ');
  const insertMatch = s.match(/INSERT\s+INTO\s+([`"]?\w+[`"]?)\s*\(([^)]+)\)/i);
  if (!insertMatch) return s;

  const table = insertMatch[1].replace(/[`"]/g, '');
  const conflictTarget = inferConflictTarget(table, insertMatch[2]);
  const dupIdx = s.search(/ON\s+DUPLICATE\s+KEY\s+UPDATE/i);
  const updatePart = s
    .slice(dupIdx)
    .replace(/ON\s+DUPLICATE\s+KEY\s+UPDATE/i, '')
    .trim()
    .replace(/;?\s*$/, '');

  const noopMatch = updatePart.match(/^([`"]?\w+[`"]?)\s*=\s*\1\s*$/i);
  if (noopMatch) {
    return `${s.slice(0, dupIdx).trim()} ON CONFLICT (${conflictTarget}) DO NOTHING`;
  }

  let setClause = updatePart.replace(
    /VALUES\s*\(\s*([`"]?\w+[`"]?)\s*\)/gi,
    (_match, col) => `EXCLUDED.${col.replace(/[`"]/g, '')}`,
  );

  const insertPart = s.slice(0, dupIdx).trim();
  return `${insertPart} ON CONFLICT (${conflictTarget}) DO UPDATE SET ${setClause}`;
}

function convertDateFunctions(sql) {
  let s = sql;

  s = s.replace(/\bNOW\s*\(\s*3\s*\)/gi, 'NOW()');
  s = s.replace(/\bCURRENT_TIMESTAMP\s*\(\s*3\s*\)/gi, 'CURRENT_TIMESTAMP');

  s = s.replace(
    /DATE_SUB\s*\(\s*([^,]+?)\s*,\s*INTERVAL\s+([^)]+?)\s+(\w+)\s*\)/gi,
    (_match, dateExpr, intervalVal, unit) => {
      const unitMap = {
        DAY: 'days',
        MONTH: 'months',
        YEAR: 'years',
        HOUR: 'hours',
        MINUTE: 'minutes',
        SECOND: 'seconds',
      };
      const pgUnit = unitMap[unit.toUpperCase()] || `${unit.toLowerCase()}s`;
      const trimmed = intervalVal.trim();
      if (/^:\w+$/.test(trimmed)) {
        return `(${dateExpr.trim()} - (${trimmed} || ' ${pgUnit}')::interval)`;
      }
      return `(${dateExpr.trim()} - INTERVAL '${trimmed} ${pgUnit}')`;
    },
  );

  s = s.replace(/\bYEAR\s*\(\s*([^)]+)\s*\)/gi, 'EXTRACT(YEAR FROM $1)');
  s = s.replace(/\bMONTH\s*\(\s*([^)]+)\s*\)/gi, 'EXTRACT(MONTH FROM $1)');

  s = s.replace(
    /DATE_FORMAT\s*\(\s*([^,]+)\s*,\s*'([^']+)'\s*\)/gi,
    (_match, expr, fmt) => {
      const pgFmt =
        MYSQL_DATE_FORMAT_TO_PG[fmt]
        || fmt
          .replace(/%Y/g, 'YYYY')
          .replace(/%m/g, 'MM')
          .replace(/%d/g, 'DD')
          .replace(/%b/g, 'Mon')
          .replace(/%H/g, 'HH24')
          .replace(/%i/g, 'MI')
          .replace(/%s/g, 'SS');
      return `TO_CHAR(${expr.trim()}, '${pgFmt}')`;
    },
  );

  return s;
}

export function convertMysqlIfToCase(sql) {
  if (!sql || !/\bIF\s*\(/i.test(sql)) return sql;

  let s = sql;
  let safety = 0;

  while (/\bIF\s*\(/i.test(s) && safety < 50) {
    safety += 1;
    const match = /\bIF\s*\(/i.exec(s);
    if (!match) break;

    const start = match.index;
    const openParen = match.index + match[0].length - 1;
    let depth = 1;
    let i = openParen + 1;
    const commas = [];

    while (i < s.length && depth > 0) {
      const ch = s[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === ',' && depth === 1) commas.push(i);
      i += 1;
    }

    if (commas.length !== 2) break;

    const cond = s.slice(openParen + 1, commas[0]).trim();
    const whenTrue = s.slice(commas[0] + 1, commas[1]).trim();
    const whenFalse = s.slice(commas[1] + 1, i - 1).trim();
    const replacement = `CASE WHEN ${cond} THEN ${whenTrue} ELSE ${whenFalse} END`;
    s = s.slice(0, start) + replacement + s.slice(i);
  }

  return s;
}

export function normalizeMysqlSqlForPostgres(sql) {
  if (!sql || typeof sql !== 'string') return sql;

  let s = sql;

  s = convertDateFunctions(s);
  s = convertInsertIgnore(s);
  s = convertOnDuplicateKeyUpdate(s);
  s = convertMysqlIfToCase(s);
  s = convertBooleanAssignmentLiterals(s);
  s = convertInsertBooleanLiterals(s);

  s = s.replace(/ENGINE=InnoDB[^;,\n)]*/gi, '');
  s = s.replace(/DEFAULT CHARSET=utf8mb4[^;,\n)]*/gi, '');
  s = s.replace(/COLLATE=utf8mb4_unicode_ci/gi, '');
  s = s.replace(/\s+COLLATE\s+utf8mb4_\w+/gi, '');
  s = s.replace(/DATETIME\(3\)/gi, 'TIMESTAMPTZ');
  s = s.replace(/CURRENT_TIMESTAMP\(3\)/gi, 'CURRENT_TIMESTAMP');
  s = s.replace(/MEDIUMTEXT/gi, 'TEXT');
  s = s.replace(/LONGTEXT/gi, 'TEXT');
  s = s.replace(/BOOLEAN NOT NULL DEFAULT 1/gi, 'BOOLEAN NOT NULL DEFAULT TRUE');
  s = s.replace(/BOOLEAN NOT NULL DEFAULT 0/gi, 'BOOLEAN NOT NULL DEFAULT FALSE');
  s = s.replace(/TINYINT\(1\)/gi, 'BOOLEAN');
  s = s.replace(/\s+ON UPDATE CURRENT_TIMESTAMP\(3\)/gi, '');
  s = s.replace(/\s+AFTER\s+[`"]?[\w]+[`"]?/gi, '');
  s = s.replace(/CONVERT\(([^)]+)\s+USING\s+utf8mb4\)/gi, 'CAST($1 AS TEXT)');
  s = s.replace(/UNIQUE KEY\s+(\w+)\s*\(([^)]+)\)/gi, 'CONSTRAINT $1 UNIQUE ($2)');
  s = s.replace(/,\s*KEY\s+`?\w+`?\s*\([^)]+\)/gi, '');
  s = s.replace(/,\s*INDEX\s+`?\w+`?\s*\([^)]+\)/gi, '');
  s = s.replace(/\bIFNULL\s*\(/gi, 'COALESCE(');
  s = s.replace(/AUTO_INCREMENT/gi, 'GENERATED BY DEFAULT AS IDENTITY');

  return s.trim();
}

/** Prepare SQL from route handlers / bootstraps for the active engine. */
export function prepareSql(sql, { postgres = false } = {}) {
  return postgres ? normalizeMysqlSqlForPostgres(sql) : sql;
}
