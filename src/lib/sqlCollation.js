/** Shared utf8mb4_unicode_ci comparisons (hosted MySQL vs connection charset). */
export const SQL_UNICODE_CI = 'utf8mb4_unicode_ci';

export function sqlParamEquals(columnOrExpr, paramName) {
  return `CONVERT(${columnOrExpr} USING utf8mb4) COLLATE ${SQL_UNICODE_CI} = CONVERT(:${paramName} USING utf8mb4) COLLATE ${SQL_UNICODE_CI}`;
}

export function sqlParamEqualsLower(columnOrExpr, paramName) {
  return `LOWER(TRIM(CONVERT(${columnOrExpr} USING utf8mb4))) COLLATE ${SQL_UNICODE_CI} = LOWER(CONVERT(:${paramName} USING utf8mb4)) COLLATE ${SQL_UNICODE_CI}`;
}

export function sqlLiteralEquals(columnOrExpr, literal) {
  const safe = String(literal).replace(/'/g, "''");
  return `CONVERT(${columnOrExpr} USING utf8mb4) COLLATE ${SQL_UNICODE_CI} = CONVERT('${safe}' USING utf8mb4) COLLATE ${SQL_UNICODE_CI}`;
}
