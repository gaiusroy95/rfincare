import { getPool } from '../db/pool.js';
import { isIgnorableEnsureError } from '../db/schemaErrors.js';
import { newId } from './ids.js';
import { pickField } from './cmsContentMap.js';

export const FLASH_TILE_CATEGORIES = [
  { id: 'mutual_fund', label: 'Mutual Fund', icon: 'TrendingUp' },
  { id: 'insurance', label: 'Insurance', icon: 'Shield' },
  { id: 'fixed_income', label: 'Fixed Income', icon: 'Landmark' },
  { id: 'post_office', label: 'Post Office', icon: 'Mail' },
  { id: 'government_schemes', label: 'Government Schemes', icon: 'Building2' },
  { id: 'investment', label: 'Investment', icon: 'Gem' },
  { id: 'retirement_planning', label: 'Retirement Planning', icon: 'Clock' },
  { id: 'wealth_management', label: 'Wealth Management', icon: 'Briefcase' },
];

const CATEGORY_IDS = new Set(FLASH_TILE_CATEGORIES.map((c) => c.id));

const DEFAULT_SEED = {
  mutual_fund: [
    {
      title: 'Invest Today for a Brighter Tomorrow',
      subtitle: 'Additional discount up to 25% on select mutual fund plans',
      buttonText: 'View Funds',
      displayOrder: 1,
      bannerImageUrl: '',
    },
    {
      title: 'Start Your SIP Journey',
      subtitle: 'SIP from ₹500/month · Equity, debt & hybrid funds',
      buttonText: 'Start Now',
      displayOrder: 2,
      bannerImageUrl: '',
    },
    {
      title: 'ELSS Funds for Tax Saving',
      subtitle: 'Save under Section 80C with top-performing tax-saver funds',
      buttonText: 'View ELSS',
      displayOrder: 3,
      bannerImageUrl: '',
    },
  ],
  insurance: [
    {
      title: 'Best time to buy Health Insurance is now',
      subtitle: 'Additional discount up to 25%* · 0%* GST on select plans',
      buttonText: 'View Plans',
      displayOrder: 1,
      bannerImageUrl: '',
    },
    {
      title: 'Secure your family with term life cover',
      subtitle: '₹1 Crore cover from ₹400/month⁺ · Compare 50+ insurers',
      buttonText: 'Get Quotes',
      displayOrder: 2,
      bannerImageUrl: '',
    },
  ],
};

let schemaReady = false;

export async function ensureFlashTilesSchema(pool = getPool()) {
  if (schemaReady) return;
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS homepage_flash_tiles (
        id CHAR(36) NOT NULL,
        category VARCHAR(64) NOT NULL,
        title VARCHAR(255) NOT NULL,
        subtitle TEXT NULL,
        button_text VARCHAR(128) NOT NULL DEFAULT 'View',
        banner_image_url TEXT NULL,
        cta_url TEXT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        display_order INT NOT NULL DEFAULT 0,
        created_by CHAR(36) NULL,
        updated_by CHAR(36) NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
    `);
    await pool.execute(`
      CREATE INDEX IF NOT EXISTS idx_flash_tiles_category_order
      ON homepage_flash_tiles (category, display_order ASC, created_at DESC)
    `);
  } catch (err) {
    if (!isIgnorableEnsureError(err)) throw err;
  }
  schemaReady = true;
}

export function normalizeFlashCategory(raw) {
  const key = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const aliases = {
    mutual_funds: 'mutual_fund',
    mutualfund: 'mutual_fund',
    mf: 'mutual_fund',
    ins: 'insurance',
    fixedincome: 'fixed_income',
    postoffice: 'post_office',
    govt_schemes: 'government_schemes',
    government: 'government_schemes',
    retirement: 'retirement_planning',
    wealth: 'wealth_management',
  };
  const mapped = aliases[key] || key;
  return CATEGORY_IDS.has(mapped) ? mapped : null;
}

function mapTileRow(row) {
  if (!row) return null;
  return {
    id: pickField(row, 'id'),
    category: pickField(row, 'category'),
    title: pickField(row, 'title'),
    subtitle: pickField(row, 'subtitle') || '',
    buttonText: pickField(row, 'button_text', 'buttonText') || 'View',
    bannerImageUrl: pickField(row, 'banner_image_url', 'bannerImageUrl') || '',
    ctaUrl: pickField(row, 'cta_url', 'ctaUrl') || '',
    isActive: Boolean(pickField(row, 'is_active', 'isActive') ?? true),
    displayOrder: Number(pickField(row, 'display_order', 'displayOrder') || 0),
    createdAt: pickField(row, 'created_at', 'createdAt'),
    updatedAt: pickField(row, 'updated_at', 'updatedAt'),
  };
}

async function seedDefaultsIfEmpty(pool, category) {
  const [[countRow]] = await pool.execute(
    `SELECT COUNT(*)::int AS c FROM homepage_flash_tiles WHERE category = :category`,
    { category },
  );
  if (Number(countRow?.c || 0) > 0) return;
  const seeds = DEFAULT_SEED[category] || [];
  for (const seed of seeds) {
    await pool.execute(
      `INSERT INTO homepage_flash_tiles
        (id, category, title, subtitle, button_text, banner_image_url, is_active, display_order)
       VALUES
        (:id, :category, :title, :subtitle, :button_text, :banner_image_url, TRUE, :display_order)`,
      {
        id: newId(),
        category,
        title: seed.title,
        subtitle: seed.subtitle || null,
        button_text: seed.buttonText || 'View',
        banner_image_url: seed.bannerImageUrl || null,
        display_order: seed.displayOrder || 0,
      },
    );
  }
}

export async function listFlashTiles({ category = null, activeOnly = false } = {}) {
  const pool = getPool();
  await ensureFlashTilesSchema(pool);

  const normalized = category ? normalizeFlashCategory(category) : null;
  if (normalized) {
    await seedDefaultsIfEmpty(pool, normalized);
  } else if (!category) {
    for (const key of Object.keys(DEFAULT_SEED)) {
      await seedDefaultsIfEmpty(pool, key);
    }
  }

  const params = {};
  const clauses = [];
  if (normalized) {
    clauses.push('category = :category');
    params.category = normalized;
  }
  if (activeOnly) {
    clauses.push('COALESCE(is_active, TRUE) = TRUE');
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.execute(
    `SELECT * FROM homepage_flash_tiles
     ${where}
     ORDER BY display_order ASC, created_at DESC`,
    params,
  );
  return (rows || []).map(mapTileRow);
}

export async function getFlashTile(id) {
  const pool = getPool();
  await ensureFlashTilesSchema(pool);
  const [[row]] = await pool.execute(
    `SELECT * FROM homepage_flash_tiles WHERE id = :id LIMIT 1`,
    { id },
  );
  return mapTileRow(row);
}

export async function createFlashTile(input, userId) {
  const category = normalizeFlashCategory(input.category);
  if (!category) {
    const err = new Error('Invalid flash tile category');
    err.status = 400;
    throw err;
  }
  const title = String(input.title || '').trim();
  if (!title) {
    const err = new Error('Title is required');
    err.status = 400;
    throw err;
  }
  const pool = getPool();
  await ensureFlashTilesSchema(pool);
  const id = newId();
  await pool.execute(
    `INSERT INTO homepage_flash_tiles
      (id, category, title, subtitle, button_text, banner_image_url, cta_url, is_active, display_order, created_by, updated_by)
     VALUES
      (:id, :category, :title, :subtitle, :button_text, :banner_image_url, :cta_url, :is_active, :display_order, :created_by, :updated_by)`,
    {
      id,
      category,
      title,
      subtitle: String(input.subtitle || '').trim() || null,
      button_text: String(input.buttonText || input.button_text || 'View').trim() || 'View',
      banner_image_url: String(input.bannerImageUrl || input.banner_image_url || '').trim() || null,
      cta_url: String(input.ctaUrl || input.cta_url || '').trim() || null,
      is_active: input.isActive === false || input.is_active === false ? false : true,
      display_order: Number(input.displayOrder ?? input.display_order ?? 0) || 0,
      created_by: userId || null,
      updated_by: userId || null,
    },
  );
  return getFlashTile(id);
}

export async function updateFlashTile(id, input, userId) {
  const existing = await getFlashTile(id);
  if (!existing) {
    const err = new Error('Flash tile not found');
    err.status = 404;
    throw err;
  }
  const category = input.category != null
    ? normalizeFlashCategory(input.category)
    : existing.category;
  if (!category) {
    const err = new Error('Invalid flash tile category');
    err.status = 400;
    throw err;
  }
  const title = input.title != null ? String(input.title).trim() : existing.title;
  if (!title) {
    const err = new Error('Title is required');
    err.status = 400;
    throw err;
  }
  const pool = getPool();
  await pool.execute(
    `UPDATE homepage_flash_tiles SET
       category = :category,
       title = :title,
       subtitle = :subtitle,
       button_text = :button_text,
       banner_image_url = :banner_image_url,
       cta_url = :cta_url,
       is_active = :is_active,
       display_order = :display_order,
       updated_by = :updated_by,
       updated_at = NOW()
     WHERE id = :id`,
    {
      id,
      category,
      title,
      subtitle:
        input.subtitle != null
          ? String(input.subtitle).trim() || null
          : existing.subtitle || null,
      button_text:
        input.buttonText != null || input.button_text != null
          ? String(input.buttonText ?? input.button_text).trim() || 'View'
          : existing.buttonText,
      banner_image_url:
        input.bannerImageUrl != null || input.banner_image_url != null
          ? String(input.bannerImageUrl ?? input.banner_image_url).trim() || null
          : existing.bannerImageUrl || null,
      cta_url:
        input.ctaUrl != null || input.cta_url != null
          ? String(input.ctaUrl ?? input.cta_url).trim() || null
          : existing.ctaUrl || null,
      is_active:
        input.isActive != null || input.is_active != null
          ? !(input.isActive === false || input.is_active === false)
          : existing.isActive,
      display_order:
        input.displayOrder != null || input.display_order != null
          ? Number(input.displayOrder ?? input.display_order) || 0
          : existing.displayOrder,
      updated_by: userId || null,
    },
  );
  return getFlashTile(id);
}

export async function duplicateFlashTile(id, userId) {
  const existing = await getFlashTile(id);
  if (!existing) {
    const err = new Error('Flash tile not found');
    err.status = 404;
    throw err;
  }
  return createFlashTile(
    {
      category: existing.category,
      title: `${existing.title} (Copy)`,
      subtitle: existing.subtitle,
      buttonText: existing.buttonText,
      bannerImageUrl: existing.bannerImageUrl,
      ctaUrl: existing.ctaUrl,
      isActive: false,
      displayOrder: Number(existing.displayOrder || 0) + 1,
    },
    userId,
  );
}

export async function deleteFlashTile(id) {
  const pool = getPool();
  await ensureFlashTilesSchema(pool);
  const [result] = await pool.execute(`DELETE FROM homepage_flash_tiles WHERE id = :id`, { id });
  const deleted = result?.affectedRows ?? result?.rowCount ?? 0;
  if (!deleted) {
    const err = new Error('Flash tile not found');
    err.status = 404;
    throw err;
  }
  return { ok: true, deleted: true };
}

/** Public carousel payload compatible with MarketplaceHero slides. */
export async function listPublicFlashSlides(categoryOrType) {
  const category =
    normalizeFlashCategory(categoryOrType)
    || normalizeFlashCategory(
      String(categoryOrType || '').replace(/s$/, ''),
    )
    || (String(categoryOrType || '').includes('mutual') ? 'mutual_fund' : null)
    || (String(categoryOrType || '').includes('insurance') ? 'insurance' : null);

  if (!category) {
    return { category: null, slides: [] };
  }

  const tiles = await listFlashTiles({ category, activeOnly: true });
  return {
    category,
    slides: tiles.map((t) => ({
      id: t.id,
      title: t.title,
      highlight: t.subtitle,
      sub: '',
      cta: t.buttonText,
      bannerImageUrl: t.bannerImageUrl,
      ctaUrl: t.ctaUrl,
      displayOrder: t.displayOrder,
    })),
  };
}
