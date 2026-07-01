import { normalizeMysqlSqlForPostgres } from '../src/db/sqlAdapter.js';

const samples = [
  `INSERT INTO marketing_settings (id) VALUES ('default') ON DUPLICATE KEY UPDATE ga_enabled = VALUES(ga_enabled)`,
  `INSERT IGNORE INTO translation_cache (source_lang, target_lang, source_hash, source_text, translated_text) VALUES ('en','hi','abc','a','b')`,
  `SELECT DATE_FORMAT(created_at, '%b') FROM t WHERE created_at >= DATE_SUB(NOW(3), INTERVAL :days DAY)`,
  `UPDATE t SET x = IF(active = 1, 'yes', 'no')`,
];

for (const s of samples) {
  console.log(normalizeMysqlSqlForPostgres(s));
  console.log('---');
}
