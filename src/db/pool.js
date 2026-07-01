import { createPool } from './createPool.js';

export { convertNamedParams, convertPositionalParams } from './params.js';
export {
  isDuplicateColumnError,
  isDuplicateEntryError,
  isIgnorableMigrationError,
  isNoSuchTableError,
  isBadFieldError,
  isTableExistsError,
} from './schemaErrors.js';

export function getPool() {
  return createPool();
}

export function getDatabaseEnvSummary() {
  const url = process.env.DATABASE_URL || '';
  let host = null;
  try {
    host = url ? new URL(url).hostname : null;
  } catch {
    host = null;
  }
  return {
    provider: 'postgres',
    engine: 'postgresql',
    host,
    configured: Boolean(process.env.DATABASE_URL),
  };
}
