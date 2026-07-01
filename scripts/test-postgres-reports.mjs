import dotenv from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPool } from '../src/db/pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

async function main() {
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT TO_CHAR(created_at, 'Mon') AS month,
            EXTRACT(MONTH FROM created_at)::int AS m,
            EXTRACT(YEAR FROM created_at)::int AS y,
            COUNT(*) AS total
     FROM loan_applications
     WHERE created_at >= NOW() - INTERVAL '12 months'
     GROUP BY EXTRACT(YEAR FROM created_at), EXTRACT(MONTH FROM created_at), TO_CHAR(created_at, 'Mon')
     ORDER BY y, m
     LIMIT 3`,
  );
  console.log('reports query rows:', rows.length);
  await pool.end?.();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
