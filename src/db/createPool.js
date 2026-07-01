import pg from 'pg';

import { convertNamedParams, convertPositionalParams } from './params.js';

const { Pool } = pg;

let pool;

function resolveSslOption() {
  const raw = String(process.env.DATABASE_SSL || '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'disable') {
    return false;
  }
  return { rejectUnauthorized: false };
}

function formatQueryResult(result) {
  const command = String(result.command || '').toUpperCase();
  if (command === 'SELECT' || command === 'SHOW') {
    return [result.rows, result.fields || []];
  }
  return [
    {
      affectedRows: result.rowCount ?? 0,
      insertId: result.rows?.[0]?.id ?? null,
    },
    result.fields || [],
  ];
}

function wrapClient(client) {
  async function run(sql, params) {
    const prepared = Array.isArray(params)
      ? convertPositionalParams(sql, params)
      : convertNamedParams(sql, params || {});
    const result = await client.query(prepared.text, prepared.values);
    return formatQueryResult(result);
  }

  return {
    execute: run,
    query: run,
    beginTransaction: async () => {
      await client.query('BEGIN');
    },
    commit: async () => {
      await client.query('COMMIT');
    },
    rollback: async () => {
      await client.query('ROLLBACK');
    },
    release: () => client.release(),
  };
}

export function createPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is required. Example: postgresql://user:pass@host/db?sslmode=require',
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
    const prepared = Array.isArray(params)
      ? convertPositionalParams(sql, params)
      : convertNamedParams(sql, params || {});
    const result = await pgPool.query(prepared.text, prepared.values);
    return formatQueryResult(result);
  }

  pool = {
    execute: run,
    query: run,
    getConnection: async () => wrapClient(await pgPool.connect()),
    end: () => pgPool.end(),
    _pgPool: pgPool,
  };

  return pool;
}

export function resetPoolForTests() {
  pool = undefined;
}
