import { getPool } from '../db/pool.js';
import { isIgnorableEnsureError } from '../db/schemaErrors.js';
import { pickField } from './cmsContentMap.js';

export const DEFAULT_CREDLAXMI_BANNER = {
  isActive: true,
  headline: 'Find Your Perfect Credit Card',
  subtitle: 'Compare top cards, maximise rewards and save on every spend.',
  tagline: 'Spend Smart Live Better!',
  ctaLabel: 'Explore Credit Cards',
  ctaPath: '/credlaxmi/credit-card-saver',
  heroImageUrl: '/images/credlaxmi-hero.svg',
  heroImageAlt: 'Shopper celebrating rewards with a credit card',
  badgeLine1: 'More Rewards',
  badgeLine2: 'More Happiness',
  benefits: [
    { icon: 'ShoppingCart', label: 'More Rewards' },
    { icon: 'TrendingDown', label: 'Lower Expenses' },
    { icon: 'Tag', label: 'Exclusive Offers' },
    { icon: 'Sparkles', label: 'A Smarter Lifestyle' },
  ],
  trustItems: [
    '100% Secure & Trusted',
    'Top Banks & Verified Cards',
    'Save Time & Make Better Choices',
    'A Smarter Financial Life',
  ],
};

const ROW_ID = 'default';
let schemaReady = false;

export async function ensureCredLaxmiBannerSchema(pool = getPool()) {
  if (schemaReady) return;
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS homepage_credlaxmi_banner (
        id VARCHAR(32) NOT NULL,
        content_json JSONB NOT NULL DEFAULT '{}'::jsonb,
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

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function normalizeBenefit(item) {
  if (!item || typeof item !== 'object') return null;
  const label = String(item.label || '').trim();
  if (!label) return null;
  return {
    icon: String(item.icon || 'Sparkles').trim() || 'Sparkles',
    label,
  };
}

export function normalizeCredLaxmiBanner(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const benefits = Array.isArray(src.benefits)
    ? src.benefits.map(normalizeBenefit).filter(Boolean).slice(0, 8)
    : [];
  const trustItems = Array.isArray(src.trustItems || src.trust_items)
    ? (src.trustItems || src.trust_items).map((t) => String(t || '').trim()).filter(Boolean).slice(0, 8)
    : [];

  return {
    isActive: src.isActive !== false && src.is_active !== false,
    headline: String(src.headline || DEFAULT_CREDLAXMI_BANNER.headline).trim(),
    subtitle: String(src.subtitle || DEFAULT_CREDLAXMI_BANNER.subtitle).trim(),
    tagline: String(src.tagline || DEFAULT_CREDLAXMI_BANNER.tagline).trim(),
    ctaLabel: String(src.ctaLabel || src.cta_label || DEFAULT_CREDLAXMI_BANNER.ctaLabel).trim(),
    ctaPath: String(src.ctaPath || src.cta_path || DEFAULT_CREDLAXMI_BANNER.ctaPath).trim(),
    heroImageUrl: String(
      src.heroImageUrl || src.hero_image_url || DEFAULT_CREDLAXMI_BANNER.heroImageUrl,
    ).trim(),
    heroImageAlt: String(
      src.heroImageAlt || src.hero_image_alt || DEFAULT_CREDLAXMI_BANNER.heroImageAlt,
    ).trim(),
    badgeLine1: String(src.badgeLine1 || src.badge_line1 || DEFAULT_CREDLAXMI_BANNER.badgeLine1).trim(),
    badgeLine2: String(src.badgeLine2 || src.badge_line2 || DEFAULT_CREDLAXMI_BANNER.badgeLine2).trim(),
    benefits: benefits.length ? benefits : DEFAULT_CREDLAXMI_BANNER.benefits,
    trustItems: trustItems.length ? trustItems : DEFAULT_CREDLAXMI_BANNER.trustItems,
    updatedAt: src.updatedAt || src.updated_at || null,
  };
}

export async function getCredLaxmiBannerContent(pool = getPool()) {
  await ensureCredLaxmiBannerSchema(pool);
  const [[row]] = await pool.execute(
    `SELECT content_json, updated_at FROM homepage_credlaxmi_banner WHERE id = :id LIMIT 1`,
    { id: ROW_ID },
  );
  if (!row) return normalizeCredLaxmiBanner(DEFAULT_CREDLAXMI_BANNER);
  const content = parseJson(row.content_json, {});
  return normalizeCredLaxmiBanner({
    ...content,
    updatedAt: row.updated_at,
  });
}

export async function upsertCredLaxmiBannerContent(input, updatedBy, pool = getPool()) {
  await ensureCredLaxmiBannerSchema(pool);
  const content = normalizeCredLaxmiBanner(pickField(input, ['content']) || input || {});
  const payload = { ...content };
  delete payload.updatedAt;

  await pool.execute(
    `INSERT INTO homepage_credlaxmi_banner (id, content_json, updated_by, updated_at)
     VALUES (:id, :content_json, :updated_by, NOW())
     ON CONFLICT (id) DO UPDATE SET
       content_json = EXCLUDED.content_json,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    {
      id: ROW_ID,
      content_json: JSON.stringify(payload),
      updated_by: updatedBy || null,
    },
  );

  return getCredLaxmiBannerContent(pool);
}
