import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { createApp } from './app.js';
import { ensureCibilCoreTables } from './db/ensureMilestone4Schema.js';
import { ensurePushNotificationSchema } from './db/ensurePushNotificationSchema.js';
import { ensurePartnerRegistrationSchema } from './db/ensurePartnerRegistrationSchema.js';
import { ensureTranslationCacheSchema } from './db/ensureTranslationCacheSchema.js';
import { ensureMarketingSchema } from './lib/marketingSettings.js';
import { getPool } from './db/pool.js';
import { getUploadDir } from './lib/uploadPaths.js';
import { isCloudStorage } from './lib/storage/index.js';
import { assertS3Config } from './lib/storage/config.js';
import { getPlatformArchitecture } from './lib/architecture.js';
import {
  getTranslationProviderName,
  isTranslationConfigured,
} from './lib/translationProvider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

const port = Number(process.env.API_PORT || 8080);

mkdirSync(getUploadDir(), { recursive: true });

if (isCloudStorage()) {
  assertS3Config();
}

const app = createApp();

async function bootstrap() {
  try {
    await ensureCibilCoreTables(getPool());
    await ensurePushNotificationSchema();
    await ensurePartnerRegistrationSchema();
    await ensureTranslationCacheSchema();
    await ensureMarketingSchema();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[api] milestone4 schema bootstrap:', err.message);
  }

  app.listen(port, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`[api] listening on :${port}`);
    const arch = getPlatformArchitecture();
    console.log(
      `[api] stack: db=${arch.database.engine} storage=${arch.storage.provider}${arch.cloudStorage ? ` bucket=${arch.storage.bucket}` : ''}`,
    );
    const translateProvider = getTranslationProviderName();
    if (translateProvider === 'google') {
      // eslint-disable-next-line no-console
      console.log('[api] translation: Google Cloud Translation API (GOOGLE_TRANSLATE_API_KEY)');
    } else if (isTranslationConfigured()) {
      // eslint-disable-next-line no-console
      console.log(`[api] translation: ${translateProvider} (set GOOGLE_TRANSLATE_API_KEY for production)`);
    } else {
      // eslint-disable-next-line no-console
      console.warn('[api] translation: disabled — set GOOGLE_TRANSLATE_API_KEY in backend/.env');
    }
  });
}

bootstrap();
