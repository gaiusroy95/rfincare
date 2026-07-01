/** Interpret BOOLEAN column values from the database driver. */
export function dbBool(value, defaultValue = false) {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  return Number(value) !== 0;
}

/** Coerce API/MySQL-style values to PostgreSQL boolean for writes. */
export function toDbBool(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return Boolean(value);
  if (value === '0' || value === '1') return value === '1';
  if (value === 'true' || value === 'false') return value === 'true';
  return Boolean(value);
}

export function isDbInactive(value) {
  return value === false || value === 0;
}
