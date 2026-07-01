/** Case-insensitive text comparison helpers for PostgreSQL. */

export function sqlCastParam(paramName) {
  return `CAST(:${paramName} AS TEXT)`;
}

/** Partial UPDATE: keep column when param is NULL (PostgreSQL needs explicit CAST). */
export function sqlCoalescePatch(column, paramName, pgType = 'TEXT') {
  return `${column} = COALESCE(CAST(:${paramName} AS ${pgType}), ${column})`;
}

export function sqlParamEquals(columnOrExpr, paramName) {
  return `CAST(${columnOrExpr} AS TEXT) = CAST(:${paramName} AS TEXT)`;
}

export function sqlParamEqualsLower(columnOrExpr, paramName) {
  return `LOWER(TRIM(CAST(${columnOrExpr} AS TEXT))) = LOWER(TRIM(CAST(:${paramName} AS TEXT)))`;
}

export function sqlLiteralEquals(columnOrExpr, literal) {
  const safe = String(literal).replace(/'/g, "''");
  return `CAST(${columnOrExpr} AS TEXT) = '${safe}'`;
}

export function sqlParamEqualsUnicode(columnOrExpr, paramName) {
  return sqlParamEquals(columnOrExpr, paramName);
}
