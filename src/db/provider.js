/**
 * Resolve database provider from environment.
 * Neon: set DATABASE_URL (auto-selects postgres unless DB_PROVIDER=mysql).
 */
export function getDbProvider() {
  const explicit = String(process.env.DB_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'postgres' || explicit === 'postgresql' || explicit === 'neon') {
    return 'postgres';
  }
  if (explicit === 'mysql') {
    return 'mysql';
  }
  if (process.env.DATABASE_URL) {
    return 'postgres';
  }
  return 'mysql';
}

export function isPostgres() {
  return getDbProvider() === 'postgres';
}

export function isMysql() {
  return getDbProvider() === 'mysql';
}
