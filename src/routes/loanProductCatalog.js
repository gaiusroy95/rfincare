import { Router } from 'express';
import { z } from 'zod';

import { authenticate } from '../middleware/authenticate.js';
import { requireRoles } from '../middleware/requireRoles.js';
import { getPool } from '../db/pool.js';
import { newId } from '../lib/ids.js';
import {
  createProductCategory,
  ensureProductCategorySchema,
  getProductCategoryById,
  listProductCategories,
} from '../lib/productCategories.js';
import {
  ensureCategoryLandingCatalog,
  syncCatalogBankProduct,
} from '../lib/syncCatalogBankProduct.js';

export const loanProductCatalogRouter = Router();

function parseFeatures(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter(Boolean).map(String);
    } catch {
      return value.split('\n').map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

function formatInterestRange(min, max) {
  if (min == null || max == null) return null;
  return `${Number(min)}% - ${Number(max)}%`;
}

function formatRow(row) {
  const features = parseFeatures(row.features);
  return {
    id: row.id,
    slug: row.slug,
    api_key: row.api_key,
    label: row.label,
    short_label: row.short_label,
    icon: row.icon || 'Wallet',
    description: row.description,
    interest_rate_min: row.interest_rate_min != null ? Number(row.interest_rate_min) : null,
    interest_rate_max: row.interest_rate_max != null ? Number(row.interest_rate_max) : null,
    interest_range: formatInterestRange(row.interest_rate_min, row.interest_rate_max),
    features,
    color: row.color || 'var(--color-primary)',
    sort_order: row.sort_order ?? 0,
    is_active: Boolean(row.is_active),
    category_id: row.category_id || null,
    category_label: row.category_label || null,
    category_slug: row.category_slug || null,
    bank_id: row.bank_id || null,
    bank_name: row.bank_name || null,
    bank_product_id: row.bank_product_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const CATALOG_SELECT = `
  SELECT c.*,
         pc.label AS category_label,
         pc.slug AS category_slug,
         b.name AS bank_name
  FROM loan_product_catalog c
  LEFT JOIN product_categories pc ON pc.id = c.category_id
  LEFT JOIN banks b ON b.id = c.bank_id
`;

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function toApiKey(slug) {
  const s = slugify(slug);
  if (!s) return null;
  return s.endsWith('_loan') ? s : `${s}_loan`;
}

function bankProductApiKey(id) {
  return `bp_${String(id).replace(/-/g, '')}`.slice(0, 64);
}

async function getBankSlugPart(pool, bankId) {
  const [[row]] = await pool.execute(`SELECT name FROM banks WHERE id = :id LIMIT 1`, { id: bankId });
  return slugify(row?.name || 'bank');
}

async function resolveUniqueCatalogSlug(pool, preferred, excludeId = null) {
  let base = slugify(preferred);
  if (!base) base = 'product';
  base = base.slice(0, 64);

  let candidate = base;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const [[row]] = await pool.execute(
      `SELECT id FROM loan_product_catalog WHERE slug = :slug LIMIT 1`,
      { slug: candidate },
    );
    if (!row || (excludeId && row.id === excludeId)) return candidate;
    const suffix =
      attempt === 0 ? newId().replace(/-/g, '').slice(0, 8) : String(attempt + 1);
    candidate = `${base.slice(0, 55)}_${suffix}`;
  }

  return `${base.slice(0, 40)}_${newId().replace(/-/g, '').slice(0, 20)}`;
}

async function buildCatalogSlug(pool, { slugInput, label, bankId, category, excludeId = null }) {
  const slugBase = slugify(slugInput || label);
  const preferred =
    bankId && category
      ? slugify(`${await getBankSlugPart(pool, bankId)}_${slugBase}_${category.slug}`)
      : slugBase;
  return resolveUniqueCatalogSlug(pool, preferred, excludeId);
}

const emptyToNull = (value) => (value === '' || value === undefined ? null : value);

const ProductSchema = z.object({
  slug: z.string().min(1).max(64).optional(),
  api_key: z.string().min(1).max(64).optional(),
  label: z.string().min(1).max(255),
  short_label: z.string().max(64).optional().nullable(),
  icon: z.string().max(64).optional(),
  description: z.string().optional().nullable(),
  interest_rate_min: z.coerce.number().min(0).max(100).optional().nullable(),
  interest_rate_max: z.coerce.number().min(0).max(100).optional().nullable(),
  features: z.union([z.array(z.string()), z.string()]).optional(),
  color: z.string().max(32).optional(),
  sort_order: z.coerce.number().int().optional(),
  is_active: z.boolean().optional(),
  category_id: z.preprocess(emptyToNull, z.union([z.string().min(1), z.null()]).optional()),
  bank_id: z.preprocess(emptyToNull, z.union([z.string().min(1), z.null()]).optional()),
});

const CategorySchema = z.object({
  label: z.string().min(1).max(255),
  slug: z.string().max(64).optional(),
  parent_loan_type: z.string().max(64).optional().nullable(),
});

/** Public: active catalog products for homepage and forms */
loanProductCatalogRouter.get('/', async (req, res, next) => {
  try {
    await ensureProductCategorySchema();
    const pool = getPool();
    const [rows] = await pool.execute(
      `${CATALOG_SELECT}
       WHERE c.is_active = 1 AND c.bank_id IS NULL
       ORDER BY c.sort_order ASC, c.label ASC`,
    );
    res.json(rows.map(formatRow));
  } catch (err) {
    next(err);
  }
});

/** Product category taxonomy for admin dropdowns */
loanProductCatalogRouter.get('/categories', async (_req, res, next) => {
  try {
    const categories = await listProductCategories();
    res.json(categories);
  } catch (err) {
    next(err);
  }
});

loanProductCatalogRouter.post(
  '/categories',
  authenticate,
  requireRoles('admin', 'super_admin'),
  async (req, res, next) => {
    try {
      const body = CategorySchema.parse(req.body);
      const category = await createProductCategory({
        label: body.label,
        slug: body.slug,
        parentLoanType: body.parent_loan_type,
      });
      const pool = getPool();
      await ensureCategoryLandingCatalog(pool, category);
      res.status(201).json(category);
    } catch (err) {
      next(err);
    }
  },
);

/** Admin: all catalog products */
loanProductCatalogRouter.get(
  '/all',
  authenticate,
  requireRoles('admin', 'super_admin'),
  async (req, res, next) => {
    try {
      await ensureProductCategorySchema();
      const pool = getPool();
      const [rows] = await pool.execute(
        `${CATALOG_SELECT} ORDER BY c.sort_order ASC, c.label ASC`,
      );
      res.json(rows.map(formatRow));
    } catch (err) {
      next(err);
    }
  },
);

loanProductCatalogRouter.post(
  '/',
  authenticate,
  requireRoles('admin', 'super_admin'),
  async (req, res, next) => {
    try {
      await ensureProductCategorySchema();
      const body = ProductSchema.parse(req.body);
      const category = body.category_id ? await getProductCategoryById(body.category_id) : null;
      const pool = getPool();
      const id = newId();
      const slug = await buildCatalogSlug(pool, {
        slugInput: body.slug,
        label: body.label,
        bankId: body.bank_id,
        category,
      });
      const apiKey = body.bank_id
        ? bankProductApiKey(id)
        : body.api_key
          ? slugify(body.api_key)
          : category
            ? (category.slug.endsWith('_loan') ? category.slug : `${category.slug}_loan`)
            : toApiKey(slug);
      if (!slug || !apiKey) {
        const e = new Error('Invalid slug or API key');
        e.status = 400;
        throw e;
      }

      const features = parseFeatures(body.features);

      await pool.execute(
        `INSERT INTO loan_product_catalog (
          id, slug, api_key, label, short_label, icon, description,
          category_id, bank_id,
          interest_rate_min, interest_rate_max, features, color, sort_order, is_active
        ) VALUES (
          :id, :slug, :api_key, :label, :short_label, :icon, :description,
          :category_id, :bank_id,
          :interest_rate_min, :interest_rate_max, :features, :color, :sort_order, :is_active
        )`,
        {
          id,
          slug,
          api_key: apiKey,
          label: body.label,
          short_label: body.short_label || body.label.split(' ')[0],
          icon: body.icon || 'Wallet',
          description: body.description || null,
          category_id: body.category_id || null,
          bank_id: body.bank_id || null,
          interest_rate_min: body.interest_rate_min ?? null,
          interest_rate_max: body.interest_rate_max ?? null,
          features: JSON.stringify(features),
          color: body.color || 'var(--color-primary)',
          sort_order: body.sort_order ?? 0,
          is_active: body.is_active === false ? 0 : 1,
        },
      );

      if (category) {
        await ensureCategoryLandingCatalog(pool, category);
      }

      if (body.bank_id && category) {
        await syncCatalogBankProduct({
          catalogId: id,
          bankId: body.bank_id,
          category,
          label: body.label,
          features,
          interestRateMin: body.interest_rate_min,
          interestRateMax: body.interest_rate_max,
        });
      }

      const [[row]] = await pool.execute(`${CATALOG_SELECT} WHERE c.id = :id LIMIT 1`, { id });
      res.status(201).json(formatRow(row));
    } catch (err) {
      if (err?.code === 'ER_DUP_ENTRY') {
        err.status = 409;
        err.message = 'A product with this slug or API key already exists';
      }
      next(err);
    }
  },
);

loanProductCatalogRouter.patch(
  '/:id',
  authenticate,
  requireRoles('admin', 'super_admin'),
  async (req, res, next) => {
    try {
      await ensureProductCategorySchema();
      const pool = getPool();
      const [[existing]] = await pool.execute(
        `SELECT * FROM loan_product_catalog WHERE id = :id LIMIT 1`,
        { id: req.params.id },
      );
      if (!existing) {
        const e = new Error('Product not found');
        e.status = 404;
        throw e;
      }

      const body = ProductSchema.partial().parse(req.body);
      const categoryId = body.category_id !== undefined ? body.category_id : existing.category_id;
      const bankId = body.bank_id !== undefined ? body.bank_id : existing.bank_id;
      const category = categoryId ? await getProductCategoryById(categoryId) : null;
      const label = body.label ?? existing.label;
      const slugInputChanged = body.slug != null || body.label != null || body.bank_id != null || body.category_id != null;
      const slug = slugInputChanged
        ? await buildCatalogSlug(pool, {
            slugInput: body.slug ?? existing.slug,
            label,
            bankId,
            category,
            excludeId: req.params.id,
          })
        : existing.slug;
      const apiKey =
        bankId && !existing.bank_id
          ? bankProductApiKey(req.params.id)
          : body.api_key != null
            ? slugify(body.api_key)
            : existing.api_key;
      const features =
        body.features !== undefined
          ? parseFeatures(body.features)
          : parseFeatures(existing.features);

      await pool.execute(
        `UPDATE loan_product_catalog SET
          slug = :slug,
          api_key = :api_key,
          label = COALESCE(:label, label),
          short_label = COALESCE(:short_label, short_label),
          icon = COALESCE(:icon, icon),
          description = COALESCE(:description, description),
          category_id = :category_id,
          bank_id = :bank_id,
          interest_rate_min = COALESCE(:interest_rate_min, interest_rate_min),
          interest_rate_max = COALESCE(:interest_rate_max, interest_rate_max),
          features = :features,
          color = COALESCE(:color, color),
          sort_order = COALESCE(:sort_order, sort_order),
          is_active = COALESCE(:is_active, is_active)
         WHERE id = :id`,
        {
          id: req.params.id,
          slug,
          api_key: apiKey,
          label: body.label ?? null,
          short_label: body.short_label ?? null,
          icon: body.icon ?? null,
          description: body.description ?? null,
          category_id: categoryId,
          bank_id: bankId,
          interest_rate_min: body.interest_rate_min ?? null,
          interest_rate_max: body.interest_rate_max ?? null,
          features: JSON.stringify(features),
          color: body.color ?? null,
          sort_order: body.sort_order ?? null,
          is_active: body.is_active === undefined ? null : body.is_active ? 1 : 0,
        },
      );

      if (category) {
        await ensureCategoryLandingCatalog(pool, category);
      }

      if (bankId && category) {
        await syncCatalogBankProduct({
          catalogId: req.params.id,
          bankId,
          category,
          label,
          features,
          interestRateMin: body.interest_rate_min ?? existing.interest_rate_min,
          interestRateMax: body.interest_rate_max ?? existing.interest_rate_max,
          bankProductId: existing.bank_product_id,
        });
      }

      const [[row]] = await pool.execute(`${CATALOG_SELECT} WHERE c.id = :id LIMIT 1`, {
        id: req.params.id,
      });
      res.json(formatRow(row));
    } catch (err) {
      if (err?.code === 'ER_DUP_ENTRY') {
        err.status = 409;
        err.message = 'A product with this slug or API key already exists';
      }
      next(err);
    }
  },
);

loanProductCatalogRouter.delete(
  '/:id',
  authenticate,
  requireRoles('admin', 'super_admin'),
  async (req, res, next) => {
    try {
      const pool = getPool();
      const [result] = await pool.execute(
        `DELETE FROM loan_product_catalog WHERE id = :id`,
        { id: req.params.id },
      );
      if (result.affectedRows === 0) {
        const e = new Error('Product not found');
        e.status = 404;
        throw e;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);
