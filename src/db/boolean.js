/** Interpret MySQL TINYINT(1) or PostgreSQL BOOLEAN column values in application code. */
export function dbBool(value, defaultValue = false) {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  return Number(value) !== 0;
}

export function isDbInactive(value) {
  return value === false || value === 0;
}
