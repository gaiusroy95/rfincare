/**
 * Pluggable machine-translation provider.
 *
 * Configure ONE of the following via environment variables for production:
 *   - GOOGLE_TRANSLATE_API_KEY        -> Google Cloud Translation v2 (REST)
 *   - LIBRETRANSLATE_URL              -> a LibreTranslate instance
 *       (optional LIBRETRANSLATE_API_KEY)
 *   - DEEPL_API_KEY                   -> DeepL (free or pro auto-detected)
 *
 * If none are configured we fall back to the free, keyless public Google
 * endpoint ("gtx") so translation works out of the box for development/demo.
 * That endpoint is unofficial and rate-limited, so set a real provider key in
 * production. Set DISABLE_FREE_TRANSLATE=true to turn the fallback off entirely
 * (provider becomes a no-op and text stays in English).
 */

const GOOGLE_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
const GTX_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function getTranslationProviderName() {
  if (process.env.GOOGLE_TRANSLATE_API_KEY) return 'google';
  if (process.env.LIBRETRANSLATE_URL) return 'libretranslate';
  if (process.env.DEEPL_API_KEY) return 'deepl';
  if (process.env.DISABLE_FREE_TRANSLATE === 'true') return 'none';
  return 'gtx';
}

export function isTranslationConfigured() {
  return getTranslationProviderName() !== 'none';
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function run() {
    while (index < items.length) {
      const i = index;
      index += 1;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/** Free, keyless public Google endpoint. Unofficial — use a real key in prod. */
async function translateGtxFree(texts, target, source) {
  return mapWithConcurrency(texts, 6, async (text) => {
    try {
      const url = `${GTX_ENDPOINT}?client=gtx&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) return text;
      const data = await res.json();
      // data[0] is an array of [translatedSegment, originalSegment, ...]
      const segments = Array.isArray(data?.[0]) ? data[0] : [];
      const joined = segments.map((s) => (Array.isArray(s) ? s[0] : '')).join('');
      return joined || text;
    } catch {
      return text;
    }
  });
}

async function translateGoogle(texts, target, source) {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY;
  const out = [];
  // Google allows multiple `q` params per request; keep batches modest.
  for (const batch of chunk(texts, 100)) {
    const params = new URLSearchParams();
    params.set('key', key);
    params.set('target', target);
    params.set('source', source);
    params.set('format', 'text');
    for (const q of batch) params.append('q', q);

    const res = await fetch(GOOGLE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Google Translate error ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = await res.json();
    const translations = data?.data?.translations || [];
    batch.forEach((_, i) => out.push(translations[i]?.translatedText ?? batch[i]));
  }
  return out;
}

async function translateLibre(texts, target, source) {
  const base = process.env.LIBRETRANSLATE_URL.replace(/\/$/, '');
  const apiKey = process.env.LIBRETRANSLATE_API_KEY || undefined;
  const out = [];
  for (const batch of chunk(texts, 50)) {
    const res = await fetch(`${base}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: batch, source, target, format: 'text', api_key: apiKey }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`LibreTranslate error ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = await res.json();
    // LibreTranslate returns an array when given an array, a string otherwise.
    const translated = Array.isArray(data?.translatedText) ? data.translatedText : [data?.translatedText];
    batch.forEach((_, i) => out.push(translated[i] ?? batch[i]));
  }
  return out;
}

async function translateDeepl(texts, target, source) {
  const key = process.env.DEEPL_API_KEY;
  const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const out = [];
  for (const batch of chunk(texts, 50)) {
    const params = new URLSearchParams();
    params.set('auth_key', key);
    params.set('target_lang', target.toUpperCase());
    params.set('source_lang', source.toUpperCase());
    for (const t of batch) params.append('text', t);

    const res = await fetch(`${host}/v2/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`DeepL error ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = await res.json();
    const translations = data?.translations || [];
    batch.forEach((_, i) => out.push(translations[i]?.text ?? batch[i]));
  }
  return out;
}

/**
 * Translate an array of strings. Returns an array aligned to the input.
 * Falls back to the source text on any provider error.
 */
export async function translateTexts(texts, target, source = 'en') {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  if (!target || target === source) return [...texts];

  const provider = getTranslationProviderName();
  try {
    if (provider === 'google') return await translateGoogle(texts, target, source);
    if (provider === 'libretranslate') return await translateLibre(texts, target, source);
    if (provider === 'deepl') return await translateDeepl(texts, target, source);
    if (provider === 'gtx') return await translateGtxFree(texts, target, source);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[translate] provider error:', err.message);
    return [...texts];
  }
  return [...texts];
}
