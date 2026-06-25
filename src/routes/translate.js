import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { ensureTranslationCacheSchema } from '../db/ensureTranslationCacheSchema.js';
import {
  translateTexts,
  isTranslationConfigured,
  getTranslationProviderName,
} from '../lib/translationProvider.js';

export const translateRouter = Router();

const SUPPORTED = new Set(['en', 'hi', 'mr', 'gu', 'bn', 'ta', 'te', 'kn']);
const MAX_ITEMS = 400;
const MAX_LEN = 5000;

const TranslateSchema = z.object({
  q: z.array(z.string()).max(MAX_ITEMS),
  target: z.string().min(2).max(8),
  source: z.string().min(2).max(8).optional(),
});

function sha1(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

translateRouter.get('/status', (_req, res) => {
  const provider = getTranslationProviderName();
  res.json({
    configured: isTranslationConfigured(),
    provider,
    googleApiKeySet: Boolean(process.env.GOOGLE_TRANSLATE_API_KEY),
    freeTierNote:
      provider === 'google'
        ? 'Google Cloud: first 500,000 characters/month free, then paid per character.'
        : undefined,
  });
});

translateRouter.post('/', async (req, res, next) => {
  try {
    const body = TranslateSchema.parse(req.body);
    const source = (body.source || 'en').split('-')[0];
    const target = body.target.split('-')[0];

    // Nothing to do — echo back unchanged.
    if (target === source || !SUPPORTED.has(target)) {
      return res.json({ translations: body.q, provider: 'none', cached: body.q.length });
    }

    // De-duplicate and ignore empty/oversized strings.
    const originals = body.q.map((s) => (typeof s === 'string' ? s : ''));
    const uniqueTexts = [...new Set(originals.filter((s) => s.trim() && s.length <= MAX_LEN))];

    const result = new Map(); // source text -> translated text
    if (uniqueTexts.length === 0) {
      return res.json({ translations: originals, provider: getTranslationProviderName(), cached: 0 });
    }

    const pool = getPool();
    await ensureTranslationCacheSchema(pool);

    const hashToText = new Map();
    for (const t of uniqueTexts) hashToText.set(sha1(t), t);
    const hashes = [...hashToText.keys()];

    // 1) Look up cache.
    const placeholders = hashes.map(() => '?').join(',');
    const [rows] = await pool.execute(
      `SELECT source_hash, translated_text FROM translation_cache
       WHERE target_lang = ? AND source_lang = ? AND source_hash IN (${placeholders})`,
      [target, source, ...hashes],
    );
    let cachedCount = 0;
    for (const row of rows) {
      const text = hashToText.get(row.source_hash);
      if (text !== undefined) {
        result.set(text, row.translated_text);
        cachedCount += 1;
      }
    }

    // 2) Translate the misses via the provider.
    const misses = uniqueTexts.filter((t) => !result.has(t));
    if (misses.length > 0 && isTranslationConfigured()) {
      const translated = await translateTexts(misses, target, source);
      const inserts = [];
      misses.forEach((src, i) => {
        const out = translated[i] ?? src;
        result.set(src, out);
        // Only cache real translations (skip no-op passthroughs).
        if (out && out !== src) {
          inserts.push([source, target, sha1(src), src, out]);
        }
      });

      if (inserts.length > 0) {
        const valuesSql = inserts.map(() => '(?,?,?,?,?)').join(',');
        await pool.execute(
          `INSERT IGNORE INTO translation_cache
             (source_lang, target_lang, source_hash, source_text, translated_text)
           VALUES ${valuesSql}`,
          inserts.flat(),
        );
      }
    }

    // 3) Map back to the original (possibly duplicated) input order.
    const translations = originals.map((s) => result.get(s) ?? s);

    res.json({
      translations,
      provider: getTranslationProviderName(),
      cached: cachedCount,
      translated: misses.length,
    });
  } catch (err) {
    next(err);
  }
});
