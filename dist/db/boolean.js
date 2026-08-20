function dbBool(value, defaultValue = false) {
  if (value === null || value === void 0) return defaultValue;
  if (typeof value === "boolean") return value;
  return Number(value) !== 0;
}
function toDbBool(value) {
  if (value === null || value === void 0) return value;
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1) return Boolean(value);
  if (value === "0" || value === "1") return value === "1";
  if (value === "true" || value === "false") return value === "true";
  return Boolean(value);
}
function isDbInactive(value) {
  return value === false || value === 0;
}
export {
  dbBool,
  isDbInactive,
  toDbBool
};
