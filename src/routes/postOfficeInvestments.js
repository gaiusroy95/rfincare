import { Router } from 'express';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { ensurePostOfficeSchema } from '../db/ensurePostOfficeSchema.js';
import { newId } from '../lib/ids.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import {
  getPostOfficeTaxonomy,
  normalizeCategoryList,
} from '../lib/postOfficeTaxonomy.js';
import { calculatePostOfficeMaturity } from '../lib/postOfficeCalculator.js';

export const postOfficeInvestmentsRouter = Router();

const PROVIDER_NAME = 'India Post';

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
    providerName: PROVIDER_NAME,
    name: row.name,
    slug: row.slug,
    description: row.description,
    logoUrl: row.logo_url,
    categories,
    interestRate: row.interest_rate != null ? Number(row.interest_rate) : null,
    tenureMinMonths: row.tenure_min_months != null ? Number(row.tenure_min_months) : null,
    tenureMaxMonths: row.tenure_max_months != null ? Number(row.tenure_max_months) : null,
    minDepositAmount: row.min_deposit_amount != null ? Number(row.min_deposit_amount) : null,
    maxDepositAmount: row.max_deposit_amount != null ? Number(row.max_deposit_amount) : null,
    eligibilityText: row.eligibility_text || null,
    returnsSummary: row.returns_summary || null,
    taxBenefitsText: row.tax_benefits_text || null,
    calculatorEnabled: toBool(row.calculator_enabled),
    calculatorType: row.calculator_type || null,
    compoundingFrequency: row.compounding_frequency || 'annual',
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
  name: z.string().min(1),
  slug: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  logoUrl: z.preprocess(emptyToNull, z.union([z.string().url(), z.null()]).optional()),
  categories: z.union([z.array(z.string()), z.string()]).optional(),
  interestRate: z.coerce.number().optional().nullable(),
  tenureMinMonths: z.coerce.number().optional().nullable(),
  tenureMaxMonths: z.coerce.number().optional().nullable(),
  minDepositAmount: z.coerce.number().optional().nullable(),
  maxDepositAmount: z.coerce.number().optional().nullable(),
  eligibilityText: z.string().optional().nullable(),
  returnsSummary: z.string().optional().nullable(),
  taxBenefitsText: z.string().optional().nullable(),
  calculatorEnabled: z.coerce.boolean().optional(),
  calculatorType: z.string().optional().nullable(),
  compoundingFrequency: z.string().optional().nullable(),
  applyUrl: z.preprocess(emptyToNull, z.union([z.string().url(), z.null()]).optional()),
  features: z.union([z.array(z.string()), z.string()]).optional(),
  highlights: z.string().optional().nullable(),
  displayPriority: z.coerce.number().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

const CalculateSchema = z.object({
  calculatorType: z.string().optional(),
  principal: z.coerce.number().optional(),
  lumpSum: z.coerce.number().optional(),
  monthlyDeposit: z.coerce.number().optional(),
  monthlyContribution: z.coerce.number().optional(),
  annualDeposit: z.coerce.number().optional(),
  yearlyContribution: z.coerce.number().optional(),
  annualRate: z.coerce.number().optional(),
  tenureYears: z.coerce.number().optional(),
  tenureMonths: z.coerce.number().optional(),
});

function normalizeBody(body) {
  const parsed = ProductSchema.parse(body);
  return {
    name: parsed.name,
    slug: parsed.slug || slugify(parsed.name),
    description: parsed.description || null,
    logo_url: parsed.logoUrl || null,
    categories: JSON.stringify(normalizeCategoryList(parsed.categories)),
    interest_rate: parsed.interestRate ?? null,
    tenure_min_months: parsed.tenureMinMonths ?? null,
    tenure_max_months: parsed.tenureMaxMonths ?? null,
    min_deposit_amount: parsed.minDepositAmount ?? null,
    max_deposit_amount: parsed.maxDepositAmount ?? null,
    eligibility_text: parsed.eligibilityText?.trim() || null,
    returns_summary: parsed.returnsSummary?.trim() || null,
    tax_benefits_text: parsed.taxBenefitsText?.trim() || null,
    calculator_enabled: parsed.calculatorEnabled ?? true,
    calculator_type: parsed.calculatorType || null,
    compounding_frequency: parsed.compoundingFrequency || 'annual',
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
      LOWER(COALESCE(description, '')) LIKE :search OR
      LOWER(COALESCE(highlights, '')) LIKE :search OR
      LOWER(COALESCE(eligibility_text, '')) LIKE :search
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

postOfficeInvestmentsRouter.get('/taxonomy', async (_req, res) => {
  res.json(getPostOfficeTaxonomy());
});

postOfficeInvestmentsRouter.post('/calculate', async (req, res, next) => {
  try {
    const input = CalculateSchema.parse(req.body);
    res.json(calculatePostOfficeMaturity(input));
  } catch (err) {
    next(err);
  }
});

postOfficeInvestmentsRouter.get('/', async (req, res, next) => {
  try {
    await ensurePostOfficeSchema();
    const pool = getPool();
    const { where, params } = buildListQuery(req.query);
    const [rows] = await pool.execute(
      `SELECT * FROM post_office_products
       ${where}
       ORDER BY display_priority DESC, name ASC`,
      params,
    );
    res.json(rows.map(formatRow));
  } catch (err) {
    next(err);
  }
});

postOfficeInvestmentsRouter.get('/:id', async (req, res, next) => {
  try {
    await ensurePostOfficeSchema();
    const pool = getPool();
    const [[row]] = await pool.execute(
      `SELECT * FROM post_office_products WHERE id = :id LIMIT 1`,
      { id: req.params.id },
    );
    if (!row) return res.status(404).json({ error: 'Post office product not found' });
    res.json(formatRow(row));
  } catch (err) {
    next(err);
  }
});

postOfficeInvestmentsRouter.post(
  '/',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensurePostOfficeSchema();
      const pool = getPool();
      const input = normalizeBody(req.body);
      const id = newId();
      await pool.execute(
        `INSERT INTO post_office_products (
          id, name, slug, description, logo_url, categories,
          interest_rate, tenure_min_months, tenure_max_months,
          min_deposit_amount, max_deposit_amount,
          eligibility_text, returns_summary, tax_benefits_text,
          calculator_enabled, calculator_type, compounding_frequency,
          apply_url, features, highlights, display_priority, status
        ) VALUES (
          :id, :name, :slug, :description, :logo_url, :categories::jsonb,
          :interest_rate, :tenure_min_months, :tenure_max_months,
          :min_deposit_amount, :max_deposit_amount,
          :eligibility_text, :returns_summary, :tax_benefits_text,
          :calculator_enabled, :calculator_type, :compounding_frequency,
          :apply_url, :features, :highlights, :display_priority, :status
        )`,
        { id, ...input },
      );
      const [[row]] = await pool.execute(`SELECT * FROM post_office_products WHERE id = :id`, { id });
      res.status(201).json(formatRow(row));
    } catch (err) {
      next(err);
    }
  },
);

postOfficeInvestmentsRouter.put(
  '/:id',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensurePostOfficeSchema();
      const pool = getPool();
      const input = normalizeBody(req.body);
      const [[existing]] = await pool.execute(
        `SELECT id FROM post_office_products WHERE id = :id LIMIT 1`,
        { id: req.params.id },
      );
      if (!existing) return res.status(404).json({ error: 'Post office product not found' });

      await pool.execute(
        `UPDATE post_office_products SET
          name = :name,
          slug = :slug,
          description = :description,
          logo_url = :logo_url,
          categories = :categories::jsonb,
          interest_rate = :interest_rate,
          tenure_min_months = :tenure_min_months,
          tenure_max_months = :tenure_max_months,
          min_deposit_amount = :min_deposit_amount,
          max_deposit_amount = :max_deposit_amount,
          eligibility_text = :eligibility_text,
          returns_summary = :returns_summary,
          tax_benefits_text = :tax_benefits_text,
          calculator_enabled = :calculator_enabled,
          calculator_type = :calculator_type,
          compounding_frequency = :compounding_frequency,
          apply_url = :apply_url,
          features = :features,
          highlights = :highlights,
          display_priority = :display_priority,
          status = :status,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = :id`,
        { id: req.params.id, ...input },
      );
      const [[row]] = await pool.execute(`SELECT * FROM post_office_products WHERE id = :id`, { id: req.params.id });
      res.json(formatRow(row));
    } catch (err) {
      next(err);
    }
  },
);

postOfficeInvestmentsRouter.delete(
  '/:id',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensurePostOfficeSchema();
      const pool = getPool();
      const [result] = await pool.execute(`DELETE FROM post_office_products WHERE id = :id`, { id: req.params.id });
      if (!result.affectedRows) return res.status(404).json({ error: 'Post office product not found' });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);
