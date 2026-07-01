/**
 * Copy all data from MySQL → PostgreSQL (Neon).
 *
 * Prerequisites:
 *   1. MySQL still has your production data (MYSQL_* in .env)
 *   2. Postgres schema already applied: npm run db:migrate:postgres
 *   3. DATABASE_URL points at the target Neon database
 *
 * Usage:
 *   npm run db:migrate:data              # copy data (skip tables that already have rows)
 *   npm run db:migrate:data -- --dry-run # show row counts only
 *   npm run db:migrate:data -- --truncate # wipe Postgres tables first, then copy everything
 *   npm run db:migrate:data -- --tables=auth_users,loan_applications
 */
import mysql from 'mysql2/promise';
import pg from 'pg';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

const BATCH_SIZE = Number(process.env.MIGRATE_BATCH_SIZE || 500);
const PG_SYSTEM_TABLES = new Set(['schema_migrations']);

function parseArgs(argv) {
  const flags = {
    dryRun: false,
    truncate: false,
    tables: null,
    skipExisting: true,
  };
  for (const arg of argv) {
    if (arg === '--dry-run') flags.dryRun = true;
    if (arg === '--truncate') {
      flags.truncate = true;
      flags.skipExisting = false;
    }
    if (arg === '--force') flags.skipExisting = false;
    if (arg.startsWith('--tables=')) {
      flags.tables = new Set(
        arg
          .slice('--tables='.length)
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      );
    }
  }
  return flags;
}

function mysqlConfig() {
  const host = process.env.MYSQL_HOST;
  const user = process.env.MYSQL_USER;
  const password = process.env.MYSQL_PASSWORD;
  const database = process.env.MYSQL_DATABASE;
  const port = Number(process.env.MYSQL_PORT || 3306);
  if (!host || !user || !database) {
    throw new Error('Missing MYSQL_HOST, MYSQL_USER, MYSQL_DATABASE in backend/.env');
  }
  return { host, user, password, database, port };
}

function postgresPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('Missing DATABASE_URL in backend/.env (Neon connection string)');
  }
  const sslDisabled = String(process.env.DATABASE_SSL || '').toLowerCase() === 'false';
  return new pg.Pool({
    connectionString,
    ssl: sslDisabled ? false : { rejectUnauthorized: false },
    max: 4,
  });
}

async function listMysqlTables(conn) {
  const [rows] = await conn.query('SHOW TABLES');
  const key = Object.keys(rows[0] || {})[0] || 'Tables_in_db';
  return rows.map((r) => r[key]).filter(Boolean);
}

async function listPostgresTables(client) {
  const result = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );
  return result.rows.map((r) => r.table_name);
}

async function getPostgresColumnTypes(client, table) {
  const result = await client.query(
    `SELECT column_name, data_type, udt_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  const map = new Map();
  for (const row of result.rows) {
    map.set(row.column_name, row);
  }
  return map;
}

async function getMysqlColumns(conn, table) {
  const [rows] = await conn.query(`SHOW COLUMNS FROM \`${table}\``);
  return rows.map((r) => r.Field);
}

function normalizeCell(value, pgCol) {
  if (value === null || value === undefined) return null;

  const dataType = pgCol?.data_type || '';
  const udt = pgCol?.udt_name || '';

  if (dataType === 'boolean' || udt === 'bool') {
    if (value === 0 || value === '0') return false;
    if (value === 1 || value === '1') return true;
    return Boolean(value);
  }

  if (dataType === 'json' || dataType === 'jsonb' || udt === 'json' || udt === 'jsonb') {
    if (typeof value === 'string') {
      try {
        JSON.parse(value);
        return value;
      } catch {
        return JSON.stringify(value);
      }
    }
    return JSON.stringify(value);
  }

  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return value;

  return value;
}

async function countRowsPg(client, table) {
  const result = await client.query(`SELECT COUNT(*)::int AS c FROM "${table}"`);
  return result.rows[0]?.c ?? 0;
}

async function countRowsMysql(conn, table) {
  const [rows] = await conn.query(`SELECT COUNT(*) AS c FROM \`${table}\``);
  return Number(rows[0]?.c ?? 0);
}

async function getForeignKeyEdges(client, tables) {
  const tableSet = new Set(tables);
  const result = await client.query(
    `SELECT
       tc.table_name AS child_table,
       ccu.table_name AS parent_table
     FROM information_schema.table_constraints AS tc
     JOIN information_schema.key_column_usage AS kcu
       ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage AS ccu
       ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = 'public'`,
  );

  const edges = [];
  for (const row of result.rows) {
    const { child_table: child, parent_table: parent } = row;
    if (tableSet.has(child) && tableSet.has(parent) && child !== parent) {
      edges.push({ child, parent });
    }
  }
  return edges;
}

/** Parents before children — required on Neon (no session_replication_role). */
function sortTablesForInsert(tables, edges) {
  const tableList = [...tables];
  const deps = new Map(tableList.map((t) => [t, new Set()]));
  const dependents = new Map(tableList.map((t) => [t, new Set()]));

  for (const { child, parent } of edges) {
    deps.get(child)?.add(parent);
    dependents.get(parent)?.add(child);
  }

  const sorted = [];
  const queue = tableList.filter((t) => (deps.get(t)?.size || 0) === 0);
  const remaining = new Set(tableList);

  while (queue.length) {
    const table = queue.shift();
    if (!remaining.has(table)) continue;
    remaining.delete(table);
    sorted.push(table);
    for (const child of dependents.get(table) || []) {
      deps.get(child)?.delete(table);
      if (deps.get(child)?.size === 0) queue.push(child);
    }
  }

  for (const table of remaining) sorted.push(table);
  return sorted;
}

async function sortTablesForMigration(client, tables) {
  const edges = await getForeignKeyEdges(client, tables);
  return sortTablesForInsert(tables, edges);
}

async function truncatePostgresTables(client, tables) {
  if (!tables.length) return;
  const list = tables.map((t) => `"${t}"`).join(', ');
  await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

async function copyTable({ mysqlConn, pgClient, table, flags, pgColTypes, mysqlColumns }) {
  const pgColumns = [...pgColTypes.keys()];
  const columns = mysqlColumns.filter((c) => pgColTypes.has(c));
  const skippedCols = mysqlColumns.filter((c) => !pgColTypes.has(c));

  if (!columns.length) {
    // eslint-disable-next-line no-console
    console.warn(`  skip ${table}: no shared columns`);
    return { table, copied: 0, skipped: true };
  }

  const mysqlCount = await countRowsMysql(mysqlConn, table);
  if (mysqlCount === 0) {
    // eslint-disable-next-line no-console
    console.log(`  ${table}: 0 rows in MySQL (skipped)`);
    return { table, copied: 0, skipped: true };
  }

  if (flags.skipExisting && !flags.truncate) {
    const pgCount = await countRowsPg(pgClient, table);
    if (pgCount > 0) {
      // eslint-disable-next-line no-console
      console.log(`  ${table}: Postgres already has ${pgCount} rows — skipped (use --truncate or --force)`);
      return { table, copied: 0, skipped: true };
    }
  }

  if (flags.dryRun) {
    // eslint-disable-next-line no-console
    console.log(`  ${table}: would copy ${mysqlCount} rows${skippedCols.length ? ` (drop MySQL-only: ${skippedCols.join(', ')})` : ''}`);
    return { table, copied: mysqlCount, skipped: false };
  }

  if (skippedCols.length) {
    // eslint-disable-next-line no-console
    console.warn(`  ${table}: ignoring MySQL-only columns: ${skippedCols.join(', ')}`);
  }

  const colList = columns.map((c) => `"${c}"`).join(', ');
  const [rows] = await mysqlConn.query(`SELECT * FROM \`${table}\``);

  let copied = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values = [];
    const tuplePlaceholders = batch
      .map((row, rowIdx) => {
        const base = rowIdx * columns.length;
        columns.forEach((col, colIdx) => {
          values.push(normalizeCell(row[col], pgColTypes.get(col)));
        });
        const ph = columns.map((_, colIdx) => `$${base + colIdx + 1}`).join(', ');
        return `(${ph})`;
      })
      .join(', ');

    const sql = flags.truncate
      ? `INSERT INTO "${table}" (${colList}) VALUES ${tuplePlaceholders}`
      : `INSERT INTO "${table}" (${colList}) VALUES ${tuplePlaceholders} ON CONFLICT DO NOTHING`;

    await pgClient.query(sql, values);
    copied += batch.length;
  }

  // eslint-disable-next-line no-console
  console.log(`  ${table}: copied ${copied} rows`);
  return { table, copied, skipped: false };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const mysqlConn = await mysql.createConnection({
    ...mysqlConfig(),
    multipleStatements: false,
  });
  const pgPool = postgresPool();
  const pgClient = await pgPool.connect();

  try {
  const mysqlTables = await listMysqlTables(mysqlConn);
  const pgTables = new Set(await listPostgresTables(pgClient));
  let tables = mysqlTables.filter((t) => pgTables.has(t) && !PG_SYSTEM_TABLES.has(t));

  if (flags.tables) {
    tables = tables.filter((t) => flags.tables.has(t));
  }

  if (!tables.length) {
    throw new Error('No common tables found between MySQL and PostgreSQL');
  }

  // eslint-disable-next-line no-console
  console.log(
    flags.dryRun
      ? `[dry-run] MySQL → PostgreSQL: ${tables.length} tables`
      : `Migrating MySQL → PostgreSQL: ${tables.length} tables`,
  );

  if (flags.truncate && !flags.dryRun) {
    // eslint-disable-next-line no-console
    console.log('Truncating Postgres tables…');
    await truncatePostgresTables(pgClient, tables);
  }

  const orderedTables = await sortTablesForMigration(pgClient, tables);
  if (orderedTables.length !== tables.length) {
    // eslint-disable-next-line no-console
    console.warn('Table order may be incomplete — copying in FK-aware order.');
  }

  const summary = [];
  for (const table of orderedTables) {
    const pgColTypes = await getPostgresColumnTypes(pgClient, table);
    const mysqlColumns = await getMysqlColumns(mysqlConn, table);
    const result = await copyTable({
      mysqlConn,
      pgClient,
      table,
      flags,
      pgColTypes,
      mysqlColumns,
    });
    summary.push(result);
  }

  const total = summary.reduce((n, r) => n + (r.copied || 0), 0);
  // eslint-disable-next-line no-console
  console.log(flags.dryRun ? `\nDry run complete. ${total} rows would be copied.` : `\nDone. ${total} rows copied.`);
  } finally {
    pgClient.release();
    await pgPool.end();
    await mysqlConn.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
