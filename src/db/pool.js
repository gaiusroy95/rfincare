import { getDbProvider, isPostgres } from './provider.js';
import { createMysqlPool } from './mysqlPool.js';
import { createPostgresPool } from './postgresPool.js';

export { getDbProvider, isPostgres, isMysql } from './provider.js';
export { isDuplicateColumnError, isIgnorableMigrationError } from './schemaErrors.js';
export { prepareSql, normalizeMysqlSqlForPostgres, convertNamedParams, convertPositionalParams } from './sqlAdapter.js';

export function getPool() {
  return isPostgres() ? createPostgresPool() : createMysqlPool();
}

export function getDatabaseEnvSummary() {
  const provider = getDbProvider();
  if (provider === 'postgres') {
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

  return {
    provider: 'mysql',
    engine: 'mysql',
    host: process.env.MYSQL_HOST || null,
    configured: Boolean(process.env.MYSQL_HOST && process.env.MYSQL_DATABASE),
  };
}
