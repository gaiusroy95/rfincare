import pg from 'pg';
import { convertNamedParams, normalizeMysqlSqlForPostgres } from './sqlAdapter.js';

const { Pool } = pg;

let pool;

function resolveSslOption() {
  const raw = String(process.env.DATABASE_SSL || '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'disable') {
    return false;
  }
  // Neon and most managed Postgres require SSL
  return { rejectUnauthorized: false };
}

export function createPostgresPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is required for PostgreSQL (Neon). Example: postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require',
    );
  }

  const pgPool = new Pool({
    connectionString,
    ssl: resolveSslOption(),
    max: Number(process.env.DATABASE_POOL_SIZE || 10),
    idleTimeoutMillis: Number(process.env.DATABASE_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS || 15000),
  });

  async function run(sql, params) {
    const normalized = normalizeMysqlSqlForPostgres(sql);
    const { text, values } = convertNamedParams(normalized, params || {});
    const result = await pgPool.query(text, values);
    return [result.rows, result.fields || []];
  }

  pool = {
    execute: run,
    query: run,
    end: () => pgPool.end(),
    _pgPool: pgPool,
  };

  return pool;
}

export function resetPostgresPoolForTests() {
  pool = undefined;
}
