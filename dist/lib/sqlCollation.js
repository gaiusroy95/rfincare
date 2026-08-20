function sqlCastParam(paramName) {
  return `CAST(:${paramName} AS TEXT)`;
}
function sqlCoalescePatch(column, paramName, pgType = "TEXT") {
  return `${column} = COALESCE(CAST(:${paramName} AS ${pgType}), ${column})`;
}
function sqlParamEquals(columnOrExpr, paramName) {
  return `CAST(${columnOrExpr} AS TEXT) = CAST(:${paramName} AS TEXT)`;
}
function sqlParamEqualsLower(columnOrExpr, paramName) {
  return `LOWER(TRIM(CAST(${columnOrExpr} AS TEXT))) = LOWER(TRIM(CAST(:${paramName} AS TEXT)))`;
}
function sqlLiteralEquals(columnOrExpr, literal) {
  const safe = String(literal).replace(/'/g, "''");
  return `CAST(${columnOrExpr} AS TEXT) = '${safe}'`;
}
function sqlParamEqualsUnicode(columnOrExpr, paramName) {
  return sqlParamEquals(columnOrExpr, paramName);
}
export {
  sqlCastParam,
  sqlCoalescePatch,
  sqlLiteralEquals,
  sqlParamEquals,
  sqlParamEqualsLower,
  sqlParamEqualsUnicode
};
