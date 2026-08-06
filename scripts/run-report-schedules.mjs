import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { getPool } from '../src/db/pool.js';
import { runDueReportSchedules } from '../src/lib/reportScheduleRunner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

async function main() {
  const limit = Math.min(100, Math.max(1, parseInt(process.env.REPORTS_BATCH_LIMIT, 10) || 50));
  const forceAll = String(process.env.REPORTS_FORCE_ALL || '') === '1';
  const pool = getPool();
  const result = await runDueReportSchedules(pool, { limit, forceAll });
  console.log(
    `Report schedules: checked=${result.checked} sent=${result.sent} skipped=${result.skipped} failed=${result.failed} smtp=${result.smtpConfigured}`,
  );
  if (result.failed > 0) {
    console.log(JSON.stringify(result.results.filter((r) => !r.ok && r.reason !== 'not_due'), null, 2));
  }
  process.exit(result.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Report schedule run failed:', err);
  process.exit(1);
});
