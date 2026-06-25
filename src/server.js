import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { createApp } from './app.js';
import { ensureCibilCoreTables } from './db/ensureMilestone4Schema.js';
import { ensurePushNotificationSchema } from './db/ensurePushNotificationSchema.js';
import { ensurePartnerRegistrationSchema } from './db/ensurePartnerRegistrationSchema.js';
import { ensureTranslationCacheSchema } from './db/ensureTranslationCacheSchema.js';
import { ensureLeadCollation } from './db/ensureLeadCollation.js';
import { ensureStaffOnboardingCollation } from './db/ensureOnboardingSchema.js';
import { getPool } from './db/pool.js';
import { getUploadDir } from './lib/uploadPaths.js';
import {
  getTranslationProviderName,
  isTranslationConfigured,
} from './lib/translationProvider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

const port = Number(process.env.API_PORT || 8080);

mkdirSync(getUploadDir(), { recursive: true });

const app = createApp();

async function bootstrap() {
  try {
    await ensureCibilCoreTables(getPool());
    await ensurePushNotificationSchema();
    await ensurePartnerRegistrationSchema();
    await ensureTranslationCacheSchema();
    await ensureStaffOnboardingCollation();
    await ensureLeadCollation();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[api] milestone4 schema bootstrap:', err.message);
  }

  app.listen(port, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`[api] listening on :${port}`);
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
