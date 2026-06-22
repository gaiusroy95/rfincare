/**
 * Collation-safe SQL fragments for hosted MySQL.
 * Tables often use utf8mb4_general_ci while the pool connection uses utf8mb4_unicode_ci.
 * Force both sides of comparisons to the same collation in SQL.
 */
export const SQL_CI = 'utf8mb4_general_ci';

export function sqlCastParam(paramName) {
  return `CAST(:${paramName} AS CHAR CHARACTER SET utf8mb4) COLLATE ${SQL_CI}`;
}

export function sqlParamEquals(columnOrExpr, paramName) {
  return `CONVERT(${columnOrExpr} USING utf8mb4) COLLATE ${SQL_CI} = ${sqlCastParam(paramName)}`;
}

export function sqlParamEqualsLower(columnOrExpr, paramName) {
  return `LOWER(TRIM(CONVERT(${columnOrExpr} USING utf8mb4))) COLLATE ${SQL_CI} = LOWER(${sqlCastParam(paramName)}) COLLATE ${SQL_CI}`;
}

export function sqlLiteralEquals(columnOrExpr, literal) {
  const safe = String(literal).replace(/'/g, "''");
  return `CONVERT(${columnOrExpr} USING utf8mb4) COLLATE ${SQL_CI} = CONVERT('${safe}' USING utf8mb4) COLLATE ${SQL_CI}`;
}

/** Keep unicode_ci variant for tables already migrated (loan_applications, etc.). */
export const SQL_UNICODE_CI = 'utf8mb4_unicode_ci';

export function sqlParamEqualsUnicode(columnOrExpr, paramName) {
  return `CONVERT(${columnOrExpr} USING utf8mb4) COLLATE ${SQL_UNICODE_CI} = CAST(:${paramName} AS CHAR CHARACTER SET utf8mb4) COLLATE ${SQL_UNICODE_CI}`;
}
