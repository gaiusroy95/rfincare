import pg from 'pg';

import { normalizeDbError } from './schemaErrors.js';
import {
  convertNamedParams,
  convertPositionalParams,
  normalizeMysqlSqlForPostgres,
} from './sqlAdapter.js';

const { Pool } = pg;

let pool;

function resolveSslOption() {
  const raw = String(process.env.DATABASE_SSL || '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'disable') {
    return false;
  }
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
    try {
      const prepared = Array.isArray(params)
        ? convertPositionalParams(normalized, params)
        : convertNamedParams(normalized, params || {}, { coerceBooleans: true });
      const result = await pgPool.query(prepared.text, prepared.values);
      const command = String(result.command || '').toUpperCase();

      if (command === 'SELECT' || command === 'SHOW') {
        return [result.rows, result.fields || []];
      }

      const header = {
        affectedRows: result.rowCount ?? 0,
        insertId: result.rows?.[0]?.id ?? null,
      };
      return [header, result.fields || []];
    } catch (err) {
      throw normalizeDbError(err);
    }
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
