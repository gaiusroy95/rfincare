import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { getPool } from '../src/db/pool.js';
import { runEngagementNotificationBatch } from '../src/lib/customerEngagement.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

async function main() {
  const limit = Math.min(200, Math.max(1, parseInt(process.env.ENGAGEMENT_BATCH_LIMIT, 10) || 50));
  const pool = getPool();
  const result = await runEngagementNotificationBatch(pool, { limit });
  console.log(`Engagement batch complete: processed ${result.processed} customer(s)`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Engagement batch failed:', err);
  process.exit(1);
});
