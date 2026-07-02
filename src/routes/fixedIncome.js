import { Router } from 'express';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { ensureFixedIncomeSchema } from '../db/ensureFixedIncomeSchema.js';
import { newId } from '../lib/ids.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import {
  getFixedIncomeTaxonomy,
  normalizeCategoryList,
  FIXED_INCOME_CATEGORY_SLUGS,
} from '../lib/fixedIncomeTaxonomy.js';

export const fixedIncomeRouter = Router();

const CATEGORY_SLUGS = new Set(FIXED_INCOME_CATEGORY_SLUGS);

function parseJsonList(value) {
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

function parseCategories(value) {
  if (!value) return [];
  if (Array.isArray(value)) return normalizeCategoryList(value);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return normalizeCategoryList(parsed);
    } catch {
      return normalizeCategoryList(value.split(','));
    }
  }
  return [];
}

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function toBool(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function formatRow(row) {
  const categories = parseCategories(row.categories);
  return {
    id: row.id,
    providerId: row.provider_id || null,
    providerName: row.provider_name,
    name: row.name,
    slug: row.slug,
    description: row.description,
    logoUrl: row.logo_url,
    categories,
    interestRate: row.interest_rate != null ? Number(row.interest_rate) : null,
    interestRateMin: row.interest_rate_min != null ? Number(row.interest_rate_min) : null,
    interestRateMax: row.interest_rate_max != null ? Number(row.interest_rate_max) : null,
    lockInMonths: row.lock_in_months != null ? Number(row.lock_in_months) : null,
    prematureWithdrawal: toBool(row.premature_withdrawal),
    monthlyInterest: toBool(row.monthly_interest),
    quarterlyInterest: toBool(row.quarterly_interest),
    minDepositAmount: row.min_deposit_amount != null ? Number(row.min_deposit_amount) : null,
    maxDepositAmount: row.max_deposit_amount != null ? Number(row.max_deposit_amount) : null,
    tenureMinMonths: row.tenure_min_months != null ? Number(row.tenure_min_months) : null,
    tenureMaxMonths: row.tenure_max_months != null ? Number(row.tenure_max_months) : null,
    applyUrl: row.apply_url || null,
    features: parseJsonList(row.features),
    highlights: row.highlights || null,
    displayPriority: row.display_priority ?? 0,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const emptyToNull = (value) => (value === '' || value === undefined ? null : value);

const ProductSchema = z.object({
  providerId: z.preprocess(emptyToNull, z.union([z.string().min(1), z.null()]).optional()),
  providerName: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  logoUrl: z.preprocess(emptyToNull, z.union([z.string().url(), z.null()]).optional()),
  categories: z.union([z.array(z.string()), z.string()]).optional(),
  interestRate: z.coerce.number().optional().nullable(),
  interestRateMin: z.coerce.number().optional().nullable(),
  interestRateMax: z.coerce.number().optional().nullable(),
  lockInMonths: z.coerce.number().optional().nullable(),
  prematureWithdrawal: z.coerce.boolean().optional(),
  monthlyInterest: z.coerce.boolean().optional(),
  quarterlyInterest: z.coerce.boolean().optional(),
  minDepositAmount: z.coerce.number().optional().nullable(),
  maxDepositAmount: z.coerce.number().optional().nullable(),
  tenureMinMonths: z.coerce.number().optional().nullable(),
  tenureMaxMonths: z.coerce.number().optional().nullable(),
  applyUrl: z.preprocess(emptyToNull, z.union([z.string().url(), z.null()]).optional()),
  features: z.union([z.array(z.string()), z.string()]).optional(),
  highlights: z.string().optional().nullable(),
  displayPriority: z.coerce.number().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

function normalizeBody(body) {
  const parsed = ProductSchema.parse(body);
  return {
    provider_id: parsed.providerId || null,
    provider_name: parsed.providerName,
    name: parsed.name,
    slug: parsed.slug || slugify(parsed.name),
    description: parsed.description || null,
    logo_url: parsed.logoUrl || null,
    categories: JSON.stringify(normalizeCategoryList(parsed.categories)),
    interest_rate: parsed.interestRate ?? null,
    interest_rate_min: parsed.interestRateMin ?? null,
    interest_rate_max: parsed.interestRateMax ?? null,
    lock_in_months: parsed.lockInMonths ?? null,
    premature_withdrawal: parsed.prematureWithdrawal ?? true,
    monthly_interest: parsed.monthlyInterest ?? false,
    quarterly_interest: parsed.quarterlyInterest ?? true,
    min_deposit_amount: parsed.minDepositAmount ?? null,
    max_deposit_amount: parsed.maxDepositAmount ?? null,
    tenure_min_months: parsed.tenureMinMonths ?? null,
    tenure_max_months: parsed.tenureMaxMonths ?? null,
    apply_url: parsed.applyUrl || null,
    features: JSON.stringify(parseJsonList(parsed.features)),
    highlights: parsed.highlights?.trim() || null,
    display_priority: parsed.displayPriority ?? 0,
    status: parsed.status || 'active',
  };
}

function buildListQuery(query) {
  const conditions = [];
  const params = {};

  const includeInactive = query.includeInactive === 'true';
  if (!includeInactive) conditions.push("status = 'active'");

  if (query.search) {
    conditions.push(`(
      LOWER(name) LIKE :search OR
      LOWER(provider_name) LIKE :search OR
      LOWER(COALESCE(description, '')) LIKE :search OR
      LOWER(COALESCE(highlights, '')) LIKE :search
    )`);
    params.search = `%${String(query.search).toLowerCase()}%`;
  }

  const category = query.category;
  if (category && category !== 'all') {
    const slugs = normalizeCategoryList(String(category).split(','));
    if (slugs.length === 1) {
      conditions.push('categories @> :categoryJson::jsonb');
      params.categoryJson = JSON.stringify([slugs[0]]);
    } else if (slugs.length > 1) {
      const orParts = slugs.map((slug, i) => {
        const key = `cat${i}`;
        params[key] = JSON.stringify([slug]);
        return `categories @> :${key}::jsonb`;
      });
      conditions.push(`(${orParts.join(' OR ')})`);
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

fixedIncomeRouter.get('/taxonomy', async (_req, res) => {
  res.json(getFixedIncomeTaxonomy());
});

fixedIncomeRouter.get('/', async (req, res, next) => {
  try {
    await ensureFixedIncomeSchema();
    const pool = getPool();
    const { where, params } = buildListQuery(req.query);
    const [rows] = await pool.execute(
      `SELECT * FROM fixed_income_products
       ${where}
       ORDER BY display_priority DESC, provider_name ASC, name ASC`,
      params,
    );
    res.json(rows.map(formatRow));
  } catch (err) {
    next(err);
  }
});

fixedIncomeRouter.get('/:id', async (req, res, next) => {
  try {
    await ensureFixedIncomeSchema();
    const pool = getPool();
    const [[row]] = await pool.execute(
      `SELECT * FROM fixed_income_products WHERE id = :id LIMIT 1`,
      { id: req.params.id },
    );
    if (!row) return res.status(404).json({ error: 'Fixed income product not found' });
    res.json(formatRow(row));
  } catch (err) {
    next(err);
  }
});

fixedIncomeRouter.post(
  '/',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureFixedIncomeSchema();
      const pool = getPool();
      const input = normalizeBody(req.body);
      const id = newId();
      await pool.execute(
        `INSERT INTO fixed_income_products (
          id, provider_id, provider_name, name, slug, description, logo_url, categories,
          interest_rate, interest_rate_min, interest_rate_max,
          lock_in_months, premature_withdrawal, monthly_interest, quarterly_interest,
          min_deposit_amount, max_deposit_amount, tenure_min_months, tenure_max_months,
          apply_url, features, highlights, display_priority, status
        ) VALUES (
          :id, :provider_id, :provider_name, :name, :slug, :description, :logo_url, :categories::jsonb,
          :interest_rate, :interest_rate_min, :interest_rate_max,
          :lock_in_months, :premature_withdrawal, :monthly_interest, :quarterly_interest,
          :min_deposit_amount, :max_deposit_amount, :tenure_min_months, :tenure_max_months,
          :apply_url, :features, :highlights, :display_priority, :status
        )`,
        { id, ...input },
      );
      const [[row]] = await pool.execute(`SELECT * FROM fixed_income_products WHERE id = :id`, { id });
      res.status(201).json(formatRow(row));
    } catch (err) {
      next(err);
    }
  },
);

fixedIncomeRouter.put(
  '/:id',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureFixedIncomeSchema();
      const pool = getPool();
      const input = normalizeBody(req.body);
      const [[existing]] = await pool.execute(
        `SELECT id FROM fixed_income_products WHERE id = :id LIMIT 1`,
        { id: req.params.id },
      );
      if (!existing) return res.status(404).json({ error: 'Fixed income product not found' });

      await pool.execute(
        `UPDATE fixed_income_products SET
          provider_id = :provider_id,
          provider_name = :provider_name,
          name = :name,
          slug = :slug,
          description = :description,
          logo_url = :logo_url,
          categories = :categories::jsonb,
          interest_rate = :interest_rate,
          interest_rate_min = :interest_rate_min,
          interest_rate_max = :interest_rate_max,
          lock_in_months = :lock_in_months,
          premature_withdrawal = :premature_withdrawal,
          monthly_interest = :monthly_interest,
          quarterly_interest = :quarterly_interest,
          min_deposit_amount = :min_deposit_amount,
          max_deposit_amount = :max_deposit_amount,
          tenure_min_months = :tenure_min_months,
          tenure_max_months = :tenure_max_months,
          apply_url = :apply_url,
          features = :features,
          highlights = :highlights,
          display_priority = :display_priority,
          status = :status,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = :id`,
        { id: req.params.id, ...input },
      );
      const [[row]] = await pool.execute(`SELECT * FROM fixed_income_products WHERE id = :id`, { id: req.params.id });
      res.json(formatRow(row));
    } catch (err) {
      next(err);
    }
  },
);

fixedIncomeRouter.delete(
  '/:id',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureFixedIncomeSchema();
      const pool = getPool();
      const [result] = await pool.execute(`DELETE FROM fixed_income_products WHERE id = :id`, { id: req.params.id });
      if (!result.affectedRows) return res.status(404).json({ error: 'Fixed income product not found' });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

