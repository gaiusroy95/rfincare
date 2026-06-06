import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { createApp } from './app.js';
import { ensureCibilCoreTables } from './db/ensureMilestone4Schema.js';
import { getPool } from './db/pool.js';
import { getUploadDir } from './lib/uploadPaths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

const port = Number(process.env.API_PORT || 8080);

mkdirSync(getUploadDir(), { recursive: true });

const app = createApp();

async function bootstrap() {
  try {
    await ensureCibilCoreTables(getPool());
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[api] milestone4 schema bootstrap:', err.message);
  }

  app.listen(port, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`[api] listening on :${port}`);
  });
}

bootstrap();
