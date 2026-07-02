import { Router } from 'express';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { ensureInvestmentProductSchema } from '../db/ensureInvestmentProductSchema.js';
import { newId } from '../lib/ids.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import {
  getInvestmentMarketplaceTaxonomy,
  normalizeCategoryList,
} from '../lib/investmentMarketplaceTaxonomy.js';
import { calculateInvestmentReturns } from '../lib/investmentCalculator.js';

export const investmentProductsRouter = Router();

const RISK_SLUGS = new Set(['low', 'low_to_moderate', 'moderate', 'moderately_high', 'high']);

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

function formatRow(row) {
  const categories = parseCategories(row.categories);
  return {
    id: row.id,
    providerName: row.provider_name,
    name: row.name,
    slug: row.slug,
    description: row.description,
    logoUrl: row.logo_url,
    categories,
    returns1y: row.returns_1y != null ? Number(row.returns_1y) : null,
    returns3y: row.returns_3y != null ? Number(row.returns_3y) : null,
    riskLevel: row.risk_level || null,
    expenseRatio: row.expense_ratio != null ? Number(row.expense_ratio) : null,
    minInvestmentAmount: row.min_investment_amount != null ? Number(row.min_investment_amount) : null,
    taxBenefitsText: row.tax_benefits_text || null,
    maturityTenureText: row.maturity_tenure_text || null,
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
  providerName: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  logoUrl: z.preprocess(emptyToNull, z.union([z.string().url(), z.null()]).optional()),
  categories: z.union([z.array(z.string()), z.string()]).optional(),
  returns1y: z.coerce.number().optional().nullable(),
  returns3y: z.coerce.number().optional().nullable(),
  riskLevel: z.preprocess(
    emptyToNull,
    z.union([z.enum(['low', 'low_to_moderate', 'moderate', 'moderately_high', 'high']), z.null()]).optional(),
  ),
  expenseRatio: z.coerce.number().optional().nullable(),
  minInvestmentAmount: z.coerce.number().optional().nullable(),
  taxBenefitsText: z.string().optional().nullable(),
  maturityTenureText: z.string().optional().nullable(),
  applyUrl: z.preprocess(emptyToNull, z.union([z.string().url(), z.null()]).optional()),
  features: z.union([z.array(z.string()), z.string()]).optional(),
  highlights: z.string().optional().nullable(),
  displayPriority: z.coerce.number().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

function normalizeBody(body) {
  const parsed = ProductSchema.parse(body);
  const riskLevel = parsed.riskLevel && RISK_SLUGS.has(parsed.riskLevel) ? parsed.riskLevel : null;
  return {
    provider_name: parsed.providerName,
    name: parsed.name,
    slug: parsed.slug || slugify(parsed.name),
    description: parsed.description || null,
    logo_url: parsed.logoUrl || null,
    categories: JSON.stringify(normalizeCategoryList(parsed.categories)),
    returns_1y: parsed.returns1y ?? null,
    returns_3y: parsed.returns3y ?? null,
    risk_level: riskLevel,
    expense_ratio: parsed.expenseRatio ?? null,
    min_investment_amount: parsed.minInvestmentAmount ?? null,
    tax_benefits_text: parsed.taxBenefitsText?.trim() || null,
    maturity_tenure_text: parsed.maturityTenureText?.trim() || null,
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

investmentProductsRouter.get('/taxonomy', async (_req, res) => {
  res.json(getInvestmentMarketplaceTaxonomy());
});

const InvestmentCalculateSchema = z.object({
  calculatorType: z.string().optional(),
  investmentAmount: z.coerce.number().optional(),
  principal: z.coerce.number().optional(),
  annualReturn: z.coerce.number().optional(),
  expectedReturn: z.coerce.number().optional(),
  couponRate: z.coerce.number().optional(),
  tenureYears: z.coerce.number().optional(),
  tenureMonths: z.coerce.number().optional(),
});

investmentProductsRouter.post('/calculate', async (req, res, next) => {
  try {
    const input = InvestmentCalculateSchema.parse(req.body);
    res.json(calculateInvestmentReturns(input));
  } catch (err) {
    next(err);
  }
});

investmentProductsRouter.get('/', async (req, res, next) => {
  try {
    await ensureInvestmentProductSchema();
    const pool = getPool();
    const { where, params } = buildListQuery(req.query);
    const [rows] = await pool.execute(
      `SELECT * FROM investment_products
       ${where}
       ORDER BY display_priority DESC, provider_name ASC, name ASC`,
      params,
    );
    res.json(rows.map(formatRow));
  } catch (err) {
    next(err);
  }
});

investmentProductsRouter.get('/:id', async (req, res, next) => {
  try {
    await ensureInvestmentProductSchema();
    const pool = getPool();
    const [[row]] = await pool.execute(
      `SELECT * FROM investment_products WHERE id = :id LIMIT 1`,
      { id: req.params.id },
    );
    if (!row) return res.status(404).json({ error: 'Investment product not found' });
    res.json(formatRow(row));
  } catch (err) {
    next(err);
  }
});

investmentProductsRouter.post(
  '/',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureInvestmentProductSchema();
      const pool = getPool();
      const input = normalizeBody(req.body);
      const id = newId();
      await pool.execute(
        `INSERT INTO investment_products (
          id, provider_name, name, slug, description, logo_url, categories,
          returns_1y, returns_3y, risk_level, expense_ratio,
          min_investment_amount, tax_benefits_text, maturity_tenure_text,
          apply_url, features, highlights, display_priority, status
        ) VALUES (
          :id, :provider_name, :name, :slug, :description, :logo_url, :categories::jsonb,
          :returns_1y, :returns_3y, :risk_level, :expense_ratio,
          :min_investment_amount, :tax_benefits_text, :maturity_tenure_text,
          :apply_url, :features, :highlights, :display_priority, :status
        )`,
        { id, ...input },
      );
      const [[row]] = await pool.execute(`SELECT * FROM investment_products WHERE id = :id`, { id });
      res.status(201).json(formatRow(row));
    } catch (err) {
      next(err);
    }
  },
);

investmentProductsRouter.put(
  '/:id',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureInvestmentProductSchema();
      const pool = getPool();
      const input = normalizeBody(req.body);
      const [[existing]] = await pool.execute(
        `SELECT id FROM investment_products WHERE id = :id LIMIT 1`,
        { id: req.params.id },
      );
      if (!existing) return res.status(404).json({ error: 'Investment product not found' });

      await pool.execute(
        `UPDATE investment_products SET
          provider_name = :provider_name,
          name = :name,
          slug = :slug,
          description = :description,
          logo_url = :logo_url,
          categories = :categories::jsonb,
          returns_1y = :returns_1y,
          returns_3y = :returns_3y,
          risk_level = :risk_level,
          expense_ratio = :expense_ratio,
          min_investment_amount = :min_investment_amount,
          tax_benefits_text = :tax_benefits_text,
          maturity_tenure_text = :maturity_tenure_text,
          apply_url = :apply_url,
          features = :features,
          highlights = :highlights,
          display_priority = :display_priority,
          status = :status,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = :id`,
        { id: req.params.id, ...input },
      );
      const [[row]] = await pool.execute(`SELECT * FROM investment_products WHERE id = :id`, { id: req.params.id });
      res.json(formatRow(row));
    } catch (err) {
      next(err);
    }
  },
);

investmentProductsRouter.delete(
  '/:id',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureInvestmentProductSchema();
      const pool = getPool();
      const [result] = await pool.execute(`DELETE FROM investment_products WHERE id = :id`, { id: req.params.id });
      if (!result.affectedRows) return res.status(404).json({ error: 'Investment product not found' });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);
