import { skipRuntimeSchemaOnPostgres } from './ensureHelpers.js';
import { getPool } from './pool.js';

let ensured = false;

export async function ensureTranslationCacheSchema(connOrPool) {
  if (ensured) return;
  if (skipRuntimeSchemaOnPostgres()) {
    ensured = true;
    return;
  }
  const pool = connOrPool?.execute ? connOrPool : getPool();

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS translation_cache (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      source_lang VARCHAR(8) NOT NULL DEFAULT 'en',
      target_lang VARCHAR(8) NOT NULL,
      source_hash CHAR(40) NOT NULL,
      source_text MEDIUMTEXT NOT NULL,
      translated_text MEDIUMTEXT NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_translation_cache (target_lang, source_hash, source_lang),
      INDEX idx_translation_cache_lookup (target_lang, source_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  ensured = true;
}
