/**
 * Adapt MySQL-oriented SQL and named parameters for PostgreSQL (Neon).
 */

const NAMED_PARAM_RE = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;

export function convertNamedParams(sql, params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { text: sql, values: [] };
  }

  const order = [];
  const indexByName = new Map();

  const text = sql.replace(NAMED_PARAM_RE, (_match, name) => {
    if (!indexByName.has(name)) {
      indexByName.set(name, order.length + 1);
      order.push(name);
    }
    return `$${indexByName.get(name)}`;
  });

  const values = order.map((name) => params[name]);
  return { text, values };
}

export function normalizeMysqlSqlForPostgres(sql) {
  if (!sql || typeof sql !== 'string') return sql;

  let s = sql;

  s = s.replace(/ENGINE=InnoDB[^;,\n)]*/gi, '');
  s = s.replace(/DEFAULT CHARSET=utf8mb4[^;,\n)]*/gi, '');
  s = s.replace(/COLLATE=utf8mb4_unicode_ci/gi, '');
  s = s.replace(/\s+COLLATE\s+utf8mb4_\w+/gi, '');
  s = s.replace(/DATETIME\(3\)/gi, 'TIMESTAMPTZ');
  s = s.replace(/CURRENT_TIMESTAMP\(3\)/gi, 'CURRENT_TIMESTAMP');
  s = s.replace(/BOOLEAN NOT NULL DEFAULT 1/gi, 'BOOLEAN NOT NULL DEFAULT TRUE');
  s = s.replace(/BOOLEAN NOT NULL DEFAULT 0/gi, 'BOOLEAN NOT NULL DEFAULT FALSE');
  s = s.replace(/TINYINT\(1\)/gi, 'BOOLEAN');
  s = s.replace(/\s+ON UPDATE CURRENT_TIMESTAMP\(3\)/gi, '');
  s = s.replace(/\s+AFTER\s+[`"]?[\w]+[`"]?/gi, '');
  s = s.replace(/CONVERT\(([^)]+)\s+USING\s+utf8mb4\)/gi, 'CAST($1 AS TEXT)');
  s = s.replace(/UNIQUE KEY\s+(\w+)\s*\(([^)]+)\)/gi, 'CONSTRAINT $1 UNIQUE ($2)');
  s = s.replace(/,\s*KEY\s+`?\w+`?\s*\([^)]+\)/gi, '');
  s = s.replace(/`([^`]+)`/g, '"$1"');

  return s.trim();
}

/** Prepare SQL from route handlers / bootstraps for the active engine. */
export function prepareSql(sql, { postgres = false } = {}) {
  return postgres ? normalizeMysqlSqlForPostgres(sql) : sql;
}
