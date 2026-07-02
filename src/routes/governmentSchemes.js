import { Router } from 'express';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { ensureGovernmentSchemeSchema } from '../db/ensureGovernmentSchemeSchema.js';
import { newId } from '../lib/ids.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import {
  getGovernmentSchemeTaxonomy,
  normalizeCategoryList,
} from '../lib/governmentSchemeTaxonomy.js';

export const governmentSchemesRouter = Router();

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
    ministryName: row.ministry_name,
    name: row.name,
    slug: row.slug,
    description: row.description,
    logoUrl: row.logo_url,
    categories,
    loanAmountMin: row.loan_amount_min != null ? Number(row.loan_amount_min) : null,
    loanAmountMax: row.loan_amount_max != null ? Number(row.loan_amount_max) : null,
    subsidyPercent: row.subsidy_percent != null ? Number(row.subsidy_percent) : null,
    interestRate: row.interest_rate != null ? Number(row.interest_rate) : null,
    eligibilityText: row.eligibility_text || null,
    benefitsText: row.benefits_text || null,
    applicationUrl: row.application_url || null,
    features: parseJsonList(row.features),
    highlights: row.highlights || null,
    displayPriority: row.display_priority ?? 0,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const emptyToNull = (value) => (value === '' || value === undefined ? null : value);

const SchemeSchema = z.object({
  ministryName: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  logoUrl: z.preprocess(emptyToNull, z.union([z.string().url(), z.null()]).optional()),
  categories: z.union([z.array(z.string()), z.string()]).optional(),
  loanAmountMin: z.coerce.number().optional().nullable(),
  loanAmountMax: z.coerce.number().optional().nullable(),
  subsidyPercent: z.coerce.number().optional().nullable(),
  interestRate: z.coerce.number().optional().nullable(),
  eligibilityText: z.string().optional().nullable(),
  benefitsText: z.string().optional().nullable(),
  applicationUrl: z.preprocess(emptyToNull, z.union([z.string().url(), z.null()]).optional()),
  features: z.union([z.array(z.string()), z.string()]).optional(),
  highlights: z.string().optional().nullable(),
  displayPriority: z.coerce.number().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

function normalizeBody(body) {
  const parsed = SchemeSchema.parse(body);
  return {
    ministry_name: parsed.ministryName,
    name: parsed.name,
    slug: parsed.slug || slugify(parsed.name),
    description: parsed.description || null,
    logo_url: parsed.logoUrl || null,
    categories: JSON.stringify(normalizeCategoryList(parsed.categories)),
    loan_amount_min: parsed.loanAmountMin ?? null,
    loan_amount_max: parsed.loanAmountMax ?? null,
    subsidy_percent: parsed.subsidyPercent ?? null,
    interest_rate: parsed.interestRate ?? null,
    eligibility_text: parsed.eligibilityText?.trim() || null,
    benefits_text: parsed.benefitsText?.trim() || null,
    application_url: parsed.applicationUrl || null,
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
      LOWER(ministry_name) LIKE :search OR
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

governmentSchemesRouter.get('/taxonomy', async (_req, res) => {
  res.json(getGovernmentSchemeTaxonomy());
});

governmentSchemesRouter.get('/', async (req, res, next) => {
  try {
    await ensureGovernmentSchemeSchema();
    const pool = getPool();
    const { where, params } = buildListQuery(req.query);
    const [rows] = await pool.execute(
      `SELECT * FROM government_schemes
       ${where}
       ORDER BY display_priority DESC, ministry_name ASC, name ASC`,
      params,
    );
    res.json(rows.map(formatRow));
  } catch (err) {
    next(err);
  }
});

governmentSchemesRouter.get('/:id', async (req, res, next) => {
  try {
    await ensureGovernmentSchemeSchema();
    const pool = getPool();
    const [[row]] = await pool.execute(
      `SELECT * FROM government_schemes WHERE id = :id LIMIT 1`,
      { id: req.params.id },
    );
    if (!row) return res.status(404).json({ error: 'Government scheme not found' });
    res.json(formatRow(row));
  } catch (err) {
    next(err);
  }
});

governmentSchemesRouter.post(
  '/',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureGovernmentSchemeSchema();
      const pool = getPool();
      const input = normalizeBody(req.body);
      const id = newId();
      await pool.execute(
        `INSERT INTO government_schemes (
          id, ministry_name, name, slug, description, logo_url, categories,
          loan_amount_min, loan_amount_max, subsidy_percent, interest_rate,
          eligibility_text, benefits_text, application_url,
          features, highlights, display_priority, status
        ) VALUES (
          :id, :ministry_name, :name, :slug, :description, :logo_url, :categories::jsonb,
          :loan_amount_min, :loan_amount_max, :subsidy_percent, :interest_rate,
          :eligibility_text, :benefits_text, :application_url,
          :features, :highlights, :display_priority, :status
        )`,
        { id, ...input },
      );
      const [[row]] = await pool.execute(`SELECT * FROM government_schemes WHERE id = :id`, { id });
      res.status(201).json(formatRow(row));
    } catch (err) {
      next(err);
    }
  },
);

governmentSchemesRouter.put(
  '/:id',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureGovernmentSchemeSchema();
      const pool = getPool();
      const input = normalizeBody(req.body);
      const [[existing]] = await pool.execute(
        `SELECT id FROM government_schemes WHERE id = :id LIMIT 1`,
        { id: req.params.id },
      );
      if (!existing) return res.status(404).json({ error: 'Government scheme not found' });

      await pool.execute(
        `UPDATE government_schemes SET
          ministry_name = :ministry_name,
          name = :name,
          slug = :slug,
          description = :description,
          logo_url = :logo_url,
          categories = :categories::jsonb,
          loan_amount_min = :loan_amount_min,
          loan_amount_max = :loan_amount_max,
          subsidy_percent = :subsidy_percent,
          interest_rate = :interest_rate,
          eligibility_text = :eligibility_text,
          benefits_text = :benefits_text,
          application_url = :application_url,
          features = :features,
          highlights = :highlights,
          display_priority = :display_priority,
          status = :status,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = :id`,
        { id: req.params.id, ...input },
      );
      const [[row]] = await pool.execute(`SELECT * FROM government_schemes WHERE id = :id`, { id: req.params.id });
      res.json(formatRow(row));
    } catch (err) {
      next(err);
    }
  },
);

governmentSchemesRouter.delete(
  '/:id',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureGovernmentSchemeSchema();
      const pool = getPool();
      const [result] = await pool.execute(`DELETE FROM government_schemes WHERE id = :id`, { id: req.params.id });
      if (!result.affectedRows) return res.status(404).json({ error: 'Government scheme not found' });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);
