import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPool } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let ensured = false;

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--[^\n]*\n/gm, '\n')
    .trim();
}

export async function ensureOnboardingSchema() {
  if (ensured) return;
  const sql = stripSqlComments(
    readFileSync(join(__dirname, '../../migrations/009_agent_employee_onboarding.sql'), 'utf8'),
  );
  const pool = getPool();
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await pool.execute(statement);
  }
  ensured = true;
}
