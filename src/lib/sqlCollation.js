import { isPostgres } from '../db/provider.js';

/**
 * Collation-safe SQL fragments for hosted MySQL.
 * On PostgreSQL, comparisons use LOWER/CAST without MySQL collation.
 */
export const SQL_CI = 'utf8mb4_general_ci';

export function sqlCastParam(paramName) {
  if (isPostgres()) {
    return `CAST(:${paramName} AS TEXT)`;
  }
  return `CAST(:${paramName} AS CHAR CHARACTER SET utf8mb4) COLLATE ${SQL_CI}`;
}

export function sqlParamEquals(columnOrExpr, paramName) {
  if (isPostgres()) {
    return `CAST(${columnOrExpr} AS TEXT) = CAST(:${paramName} AS TEXT)`;
  }
  return `CONVERT(${columnOrExpr} USING utf8mb4) COLLATE ${SQL_CI} = ${sqlCastParam(paramName)}`;
}

export function sqlParamEqualsLower(columnOrExpr, paramName) {
  if (isPostgres()) {
    return `LOWER(TRIM(CAST(${columnOrExpr} AS TEXT))) = LOWER(TRIM(CAST(:${paramName} AS TEXT)))`;
  }
  return `LOWER(TRIM(CONVERT(${columnOrExpr} USING utf8mb4))) COLLATE ${SQL_CI} = LOWER(${sqlCastParam(paramName)}) COLLATE ${SQL_CI}`;
}

export function sqlLiteralEquals(columnOrExpr, literal) {
  const safe = String(literal).replace(/'/g, "''");
  if (isPostgres()) {
    return `CAST(${columnOrExpr} AS TEXT) = '${safe}'`;
  }
  return `CONVERT(${columnOrExpr} USING utf8mb4) COLLATE ${SQL_CI} = CONVERT('${safe}' USING utf8mb4) COLLATE ${SQL_CI}`;
}

export const SQL_UNICODE_CI = 'utf8mb4_unicode_ci';

export function sqlParamEqualsUnicode(columnOrExpr, paramName) {
  if (isPostgres()) {
    return `CAST(${columnOrExpr} AS TEXT) = CAST(:${paramName} AS TEXT)`;
  }
  return `CONVERT(${columnOrExpr} USING utf8mb4) COLLATE ${SQL_UNICODE_CI} = CAST(:${paramName} AS CHAR CHARACTER SET utf8mb4) COLLATE ${SQL_UNICODE_CI}`;
}
