import dotenv from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPool } from '../src/db/pool.js';
import { getDbProvider } from '../src/db/provider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

async function main() {
  console.log('provider:', getDbProvider());
  const pool = getPool();

  const [[health]] = await pool.execute('SELECT 1 AS ok');
  console.log('SELECT 1:', health);

  const [[admin]] = await pool.execute(
    `SELECT email FROM auth_users WHERE email = :email LIMIT 1`,
    { email: 'admin@rfincare.com' },
  );
  console.log('admin exists:', Boolean(admin));

  await pool.execute(
    `INSERT INTO marketing_settings (id, ga_enabled) VALUES ('default', 0)
     ON DUPLICATE KEY UPDATE ga_enabled = VALUES(ga_enabled)`,
    {},
  );
  console.log('upsert: ok');

  const [[month]] = await pool.execute(
    `SELECT DATE_FORMAT(created_at, '%b') AS month FROM marketing_events LIMIT 1`,
  );
  console.log('DATE_FORMAT sample:', month ?? 'no rows');

  await pool.end?.();
  console.log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
