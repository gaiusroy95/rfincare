import { getPool } from '../db/pool.js';
import { isIgnorableEnsureError } from '../db/schemaErrors.js';
import { pickField } from './cmsContentMap.js';

export const DEFAULT_INSURANCE_SLIDES = [
  {
    title: 'Best time to buy Health Insurance is now',
    highlight: 'Additional discount up to 25%*',
    sub: '0%* GST on select health insurance plans',
    cta: 'View plans',
  },
  {
    title: 'Secure your family with term life cover',
    highlight: '₹1 Crore cover from ₹400/month⁺',
    sub: 'Compare 50+ insurers in one place',
    cta: 'Get quotes',
  },
  {
    title: 'Renew motor insurance hassle-free',
    highlight: 'Upto 85% discount on 2-wheeler',
    sub: 'Instant policy comparison',
    cta: 'Compare now',
  },
];

export const DEFAULT_MUTUAL_FUND_SLIDES = [
  {
    title: 'Mutual Fund update — start a SIP today',
    highlight: 'SIP from ₹500/month',
    sub: 'Equity, debt & hybrid funds with expert-backed picks',
    cta: 'Explore funds',
  },
  {
    title: 'ELSS funds for tax-saving season',
    highlight: 'Save under Section 80C',
    sub: 'Compare top-performing tax-saver mutual funds',
    cta: 'View ELSS',
  },
  {
    title: 'Grow long-term wealth with diversified funds',
    highlight: '500+ schemes across categories',
    sub: 'Quick compare · Easy apply · Hassle-free investing',
    cta: 'Start investing',
  },
];

const DEFAULTS = {
  insurance: DEFAULT_INSURANCE_SLIDES,
  mutual_funds: DEFAULT_MUTUAL_FUND_SLIDES,
};

let schemaReady = false;

export async function ensureMarketplaceHeroSchema(pool = getPool()) {
  if (schemaReady) return;
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS marketplace_hero_content (
        id VARCHAR(32) NOT NULL,
        slides_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_by CHAR(36) NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
    `);
  } catch (err) {
    if (!isIgnorableEnsureError(err)) throw err;
  }
  schemaReady = true;
}

function parseSlides(value, fallback) {
  if (Array.isArray(value) && value.length) {
    return value.map(normalizeSlide).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.map(normalizeSlide).filter(Boolean);
      }
    } catch {
      /* ignore */
    }
  }
  return (fallback || []).map(normalizeSlide).filter(Boolean);
}

function normalizeSlide(slide) {
  if (!slide || typeof slide !== 'object') return null;
  const title = String(slide.title || '').trim();
  if (!title) return null;
  return {
    title,
    highlight: String(slide.highlight || '').trim(),
    sub: String(slide.sub || slide.subtitle || '').trim(),
    cta: String(slide.cta || slide.ctaLabel || 'View plans').trim() || 'View plans',
  };
}

function normalizeMarketplaceKey(type) {
  const raw = String(type || '').trim().toLowerCase().replace(/-/g, '_');
  if (raw === 'mutual_fund' || raw === 'mutualfunds' || raw === 'mf') return 'mutual_funds';
  if (raw === 'insurance' || raw === 'ins') return 'insurance';
  return DEFAULTS[raw] ? raw : null;
}

export async function getMarketplaceHeroContent(type = 'insurance') {
  const key = normalizeMarketplaceKey(type) || 'insurance';
  const fallback = DEFAULTS[key] || DEFAULT_INSURANCE_SLIDES;
  const pool = getPool();
  await ensureMarketplaceHeroSchema(pool);
  const [[row]] = await pool.execute(
    `SELECT id, slides_json, updated_at FROM marketplace_hero_content WHERE id = :id LIMIT 1`,
    { id: key },
  );
  if (!row) {
    return { marketplace: key, slides: fallback, updatedAt: null };
  }
  return {
    marketplace: key,
    slides: parseSlides(pickField(row, 'slides_json', 'slidesJson'), fallback),
    updatedAt: pickField(row, 'updated_at', 'updatedAt') ?? null,
  };
}

export async function getAllMarketplaceHeroContent() {
  const [insurance, mutualFunds] = await Promise.all([
    getMarketplaceHeroContent('insurance'),
    getMarketplaceHeroContent('mutual_funds'),
  ]);
  return { insurance, mutualFunds };
}

export async function upsertMarketplaceHeroContent(type, slides, userId) {
  const key = normalizeMarketplaceKey(type);
  if (!key) {
    const err = new Error('Invalid marketplace type');
    err.status = 400;
    throw err;
  }
  const normalized = parseSlides(slides, DEFAULTS[key]);
  if (!normalized.length) {
    const err = new Error('At least one slide with a title is required');
    err.status = 400;
    throw err;
  }
  const pool = getPool();
  await ensureMarketplaceHeroSchema(pool);
  await pool.execute(
    `INSERT INTO marketplace_hero_content (id, slides_json, updated_by, updated_at)
     VALUES (:id, :slides, :updated_by, NOW())
     ON CONFLICT (id) DO UPDATE SET
       slides_json = EXCLUDED.slides_json,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    {
      id: key,
      slides: JSON.stringify(normalized),
      updated_by: userId || null,
    },
  );
  return getMarketplaceHeroContent(key);
}
