/**
 * Convert MySQL migration SQL files to PostgreSQL-compatible SQL for Neon.
 * Run once: node scripts/convert-mysql-migrations-to-postgres.mjs
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mysqlDir = resolve(__dirname, '../migrations');
const pgDir = resolve(__dirname, '../migrations/postgres');

function convertSql(sql, fileName) {
  let s = sql;

  s = s.replace(/ENGINE=InnoDB[^;,\n)]*/gi, '');
  s = s.replace(/DEFAULT CHARSET=utf8mb4[^;,\n)]*/gi, '');
  s = s.replace(/COLLATE=utf8mb4_unicode_ci/gi, '');
  s = s.replace(/\s+COLLATE\s+utf8mb4_\w+/gi, '');
  s = s.replace(/DATETIME\(3\)/gi, 'TIMESTAMPTZ');
  s = s.replace(/CURRENT_TIMESTAMP\(3\)/gi, 'CURRENT_TIMESTAMP');
  s = s.replace(/\bMEDIUMTEXT\b/gi, 'TEXT');
  s = s.replace(/\bLONGTEXT\b/gi, 'TEXT');
  s = s.replace(/\bDOUBLE\b/gi, 'DOUBLE PRECISION');
  s = s.replace(/\bINT UNSIGNED\b/gi, 'INTEGER');
  s = s.replace(/TINYINT\(1\)/gi, 'BOOLEAN');
  s = s.replace(/BOOLEAN NOT NULL DEFAULT 1/gi, 'BOOLEAN NOT NULL DEFAULT TRUE');
  s = s.replace(/BOOLEAN NOT NULL DEFAULT 0/gi, 'BOOLEAN NOT NULL DEFAULT FALSE');
  s = s.replace(/BOOLEAN NULL DEFAULT 1/gi, 'BOOLEAN DEFAULT TRUE');
  s = s.replace(/BOOLEAN NULL DEFAULT 0/gi, 'BOOLEAN DEFAULT FALSE');
  s = s.replace(/\s+ON UPDATE CURRENT_TIMESTAMP(\(3\))?/gi, '');
  s = s.replace(/\s+AFTER\s+[`"]?[\w]+[`"]?/gi, '');
  s = s.replace(/UNIQUE KEY\s+(\w+)\s*\(([^)]+)\)/gi, 'CONSTRAINT $1 UNIQUE ($2)');
  s = s.replace(/,\s*KEY\s+`?(\w+)`?\s*\(([^)]+)\)/gi, '');
  s = s.replace(/`([^`]+)`/g, '"$1"');
  s = s.replace(/\bUUID\(\)/g, 'gen_random_uuid()');

  // INSERT IGNORE -> ON CONFLICT DO NOTHING (requires unique constraints in schema)
  s = s.replace(/INSERT IGNORE INTO/gi, 'INSERT INTO');

  // ON DUPLICATE KEY UPDATE id = id -> ON CONFLICT DO NOTHING style handled per-file below
  s = s.replace(
    /ON DUPLICATE KEY UPDATE\s+id\s*=\s*id\s*;?/gi,
    'ON CONFLICT (id) DO NOTHING;',
  );
  s = s.replace(
    /ON DUPLICATE KEY UPDATE\s+(\w+)\s*=\s*\1\s*;?/gi,
    'ON CONFLICT ($1) DO NOTHING;',
  );
  s = s.replace(
    /ON DUPLICATE KEY UPDATE\s+display_name\s*=\s*VALUES\(display_name\)\s*;?/gi,
    'ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;',
  );

  if (fileName === '001_init.sql' && !s.includes('pgcrypto')) {
    s = 'CREATE EXTENSION IF NOT EXISTS "pgcrypto";\n\n' + s;
  }

  if (fileName === '002_seed_indian_states.sql') {
    s = s.replace(
      /INSERT INTO indian_states/gi,
      'INSERT INTO indian_states',
    );
    if (!s.includes('ON CONFLICT')) {
      s = s.replace(/;\s*$/, '\nON CONFLICT (state_name) DO NOTHING;\n');
    }
  }

  return s.trim() + '\n';
}

mkdirSync(pgDir, { recursive: true });

const files = readdirSync(mysqlDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

for (const file of files) {
  const mysqlSql = readFileSync(join(mysqlDir, file), 'utf8');
  const pgSql = convertSql(mysqlSql, file);
  writeFileSync(join(pgDir, file), pgSql, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`Converted: ${file}`);
}

// eslint-disable-next-line no-console
console.log(`PostgreSQL migrations written to ${pgDir}`);
