import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import pg from 'pg';

import { isIgnorableMigrationError } from '../src/db/schemaErrors.js';

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

/** Legacy collation patches — skipped on PostgreSQL. */
const POSTGRES_SKIP_FILES = new Set([
  '006_collation_unicode_ci.sql',
  '029_staff_onboarding_collation.sql',
  '030_marketing_leads_collation.sql',
]);

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function isApplied(client, filename) {
  const result = await client.query(
    'SELECT 1 FROM schema_migrations WHERE filename = $1 LIMIT 1',
    [filename],
  );
  return result.rowCount > 0;
}

async function markApplied(client, filename) {
  await client.query(
    'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
    [filename],
  );
}

/** Remove line comments without breaking string literals containing "--". */
function stripLineComments(sql) {
  return sql
    .split('\n')
    .map((line) => {
      let out = '';
      let inSingle = false;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === "'" && line[i - 1] !== '\\') {
          inSingle = !inSingle;
          out += ch;
          continue;
        }
        if (!inSingle && ch === '-' && line[i + 1] === '-') {
          break;
        }
        out += ch;
      }
      return out;
    })
    .join('\n')
    .trim();
}

/** Normalize legacy ALTER ... MODIFY ... statements for PostgreSQL. */
function normalizeModifyAlter(sql) {
  const cleaned = stripLineComments(sql);
  if (!/ALTER\s+TABLE/i.test(cleaned) || !/MODIFY/i.test(cleaned)) {
    return [cleaned].filter(Boolean);
  }

  const tableMatch = cleaned.match(/ALTER\s+TABLE\s+(\w+)/i);
  if (!tableMatch) return [cleaned];

  const table = tableMatch[1];
  const modifyRe =
    /MODIFY\s+(\w+)\s+((?:VARCHAR|TEXT|CHAR|INT|BIGINT|DECIMAL)(?:\([^)]*\))?)\s*(NOT NULL)?(?:\s+DEFAULT\s+('[^']*'|[^\s,]+))?/gi;

  const statements = [];
  let match;
  while ((match = modifyRe.exec(cleaned)) !== null) {
    const [, column, dataType, notNull, defaultVal] = match;
    statements.push(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${dataType}`);
    if (notNull) {
      statements.push(`ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL`);
      if (defaultVal) {
        statements.push(`ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${defaultVal}`);
      }
    } else {
      statements.push(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP NOT NULL`);
    }
  }

  return statements.length ? statements : [];
}

function extractInlineIndexes(sql) {
  if (!/CREATE\s+TABLE/i.test(sql) || !/\bINDEX\b/i.test(sql)) return [sql];
  const tableMatch = sql.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/i);
  if (!tableMatch) return [sql];
  const table = tableMatch[1];
  const indexes = [...sql.matchAll(/,\s*INDEX\s+(\w+)\s*\(([^)]+)\)/gi)];
  if (!indexes.length) return [sql];
  const createSql = sql.replace(/,\s*INDEX\s+\w+\s*\([^)]+\)/gi, '');
  const statements = [createSql];
  for (const [, name, cols] of indexes) {
    statements.push(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`);
  }
  return statements;
}

function extractAddKeyIndexes(sql) {
  if (!/ADD\s+KEY/i.test(sql)) return [sql];
  const tableMatch = sql.match(/ALTER\s+TABLE\s+(\w+)/i);
  if (!tableMatch) return [sql];
  const table = tableMatch[1];
  const indexes = [...sql.matchAll(/ADD\s+KEY\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\(([^)]+)\)/gi)];
  if (!indexes.length) return [];
  return indexes.map(([, name, cols]) => `CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`);
}

/** UPDATE ... JOIN ... → PostgreSQL UPDATE ... FROM ... */
function normalizeUpdateJoin(sql) {
  if (!/^\s*UPDATE\s+/i.test(sql) || !/LEFT\s+JOIN/i.test(sql)) return [sql];
  const match = sql.match(
    /UPDATE\s+(\w+)\s+(\w+)\s+LEFT\s+JOIN\s+(\w+)\s+(\w+)\s+ON\s+(.+?)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/is,
  );
  if (!match) return [sql];
  const [, table, alias, joinTable, joinAlias, onClause, setClause, whereClause] = match;
  const setClean = setClause.replace(new RegExp(`${alias}\\.`, 'g'), '');
  return [
    `UPDATE ${table} ${alias} SET ${setClean.trim()} FROM ${joinTable} ${joinAlias} WHERE ${onClause.trim()} AND (${whereClause.trim()})`,
  ];
}

function normalizePostgresStatement(sql) {
  let s = sql;
  s = s.replace(/\bMEDIUMTEXT\b/gi, 'TEXT');
  s = s.replace(/\bLONGTEXT\b/gi, 'TEXT');
  s = s.replace(/\bDOUBLE\b/gi, 'DOUBLE PRECISION');
  s = s.replace(/\bINT UNSIGNED\b/gi, 'INTEGER');
  s = s.replace(
    /(\w+)\s+ENUM\s*\(([^)]+)\)(\s+NOT NULL)?(\s+DEFAULT\s+'[^']+')?/gi,
    (_, col, values, notNull, def) =>
      `${col} VARCHAR(32)${notNull || ''}${def || ''} CHECK (${col} IN (${values}))`,
  );
  s = s.replace(/\bJSON_OBJECT\b/g, 'jsonb_build_object');
  s = s.replace(/\bJSON_ARRAY\b/g, 'jsonb_build_array');
  s = s.replace(
    /ON CONFLICT \(id\) DO UPDATE SET display_name = EXCLUDED\.display_name/gi,
    'ON CONFLICT (vendor_key) DO UPDATE SET display_name = EXCLUDED.display_name',
  );

  if (/INSERT\s+INTO/i.test(s)) {
    s = s.replace(/('(?:[^'\\]|\\.)*'),\s*1,\s*1,/g, "$1, TRUE, TRUE,");
    s = s.replace(/,\s*1,\s*0(\s*\))/g, ', TRUE, FALSE$1');
    s = s.replace(/('(?:[^'\\]|\\.)*'),\s*1,(\s*jsonb_build_)/gi, "$1, TRUE,$2");
    s = s.replace(/,\s*1(\s*\))/g, ', TRUE$1');
    s = s.replace(/,\s*0(\s*\))/g, ', FALSE$1');
    s = s.replace(/VALUES\s*\(\s*'default',\s*1,/gi, "VALUES ('default', TRUE,");
  }

  return s;
}

function splitStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((part) => stripLineComments(part))
    .filter((part) => part.length > 0)
    .flatMap((part) => normalizeModifyAlter(part))
    .flatMap((part) => extractInlineIndexes(part))
    .flatMap((part) => extractAddKeyIndexes(part))
    .flatMap((part) => normalizeUpdateJoin(part))
    .map((part) => normalizePostgresStatement(part))
    .filter((part) => part.length > 0);
}

async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1
     LIMIT 1`,
    [tableName],
  );
  return result.rowCount > 0;
}

async function repairIncompleteBootstrap(client) {
  const initApplied = await isApplied(client, '001_init.sql');
  const hasAuthUsers = await tableExists(client, 'auth_users');
  if (initApplied && !hasAuthUsers) {
    // eslint-disable-next-line no-console
    console.warn(
      '[postgres] 001_init.sql was recorded but auth_users is missing — clearing migration history to re-apply.',
    );
    await client.query('DELETE FROM schema_migrations');
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required. Get it from Neon dashboard → Connection string.');
  }

  const sslDisabled = String(process.env.DATABASE_SSL || '').toLowerCase() === 'false';
  const pool = new Pool({
    connectionString,
    ssl: sslDisabled ? false : { rejectUnauthorized: false },
  });

  const client = await pool.connect();
  const migrationsDir = resolve(__dirname, '../migrations/postgres');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  try {
    await ensureMigrationsTable(client);
    await repairIncompleteBootstrap(client);

    for (const file of files) {
      if (await isApplied(client, file)) {
        // eslint-disable-next-line no-console
        console.log(`Skipped (already applied): ${file}`);
        continue;
      }

      if (POSTGRES_SKIP_FILES.has(file)) {
        await markApplied(client, file);
        // eslint-disable-next-line no-console
        console.log(`Skipped (legacy no-op patch): ${file}`);
        continue;
      }

      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      const statements = splitStatements(sql);

      await client.query('BEGIN');
      try {
        for (const statement of statements) {
          try {
            await client.query(statement);
          } catch (err) {
            if (isIgnorableMigrationError(err)) {
              // eslint-disable-next-line no-console
              console.warn(`  warn: ${file} — ${err.message}`);
              continue;
            }
            throw err;
          }
        }
        await markApplied(client, file);
        await client.query('COMMIT');
        // eslint-disable-next-line no-console
        console.log(`Applied: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        err.message = `${file}: ${err.message}`;
        throw err;
      }
    }

    // eslint-disable-next-line no-console
    console.log('PostgreSQL migrations complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
