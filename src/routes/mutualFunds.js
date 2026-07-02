import { Router } from 'express';
import { mkdirSync } from 'node:fs';
import { extname } from 'node:path';
import multer from 'multer';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { ensureMutualFundSchema } from '../db/ensureMutualFundSchema.js';
import { newId } from '../lib/ids.js';
import { getUploadDir } from '../lib/uploadPaths.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import {
  getMutualFundTaxonomy,
  normalizeCategoryList,
  MUTUAL_FUND_CATEGORY_SLUGS,
} from '../lib/mutualFundTaxonomy.js';
import { calculateMutualFundReturns } from '../lib/mutualFundCalculator.js';

export const mutualFundsRouter = Router();

const RISK_SLUGS = new Set(['low', 'low_to_moderate', 'moderate', 'moderately_high', 'high', 'very_high']);

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
  return String(input || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function toBool(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function formatFundRow(row) {
  const categories = parseCategories(row.categories);
  return {
    id: row.id,
    amcId: row.amc_id || null,
    amcName: row.amc_name,
    name: row.name,
    slug: row.slug,
    description: row.description,
    logoUrl: row.logo_url,
    categories,
    returns1y: row.returns_1y != null ? Number(row.returns_1y) : null,
    returns3y: row.returns_3y != null ? Number(row.returns_3y) : null,
    returns5y: row.returns_5y != null ? Number(row.returns_5y) : null,
    riskLevel: row.risk_level || null,
    expenseRatio: row.expense_ratio != null ? Number(row.expense_ratio) : null,
    fundManager: row.fund_manager || null,
    aumCrores: row.aum_crores != null ? Number(row.aum_crores) : null,
    rating: row.rating != null ? Number(row.rating) : null,
    minSipAmount: row.min_sip_amount != null ? Number(row.min_sip_amount) : null,
    minLumpsumAmount: row.min_lumpsum_amount != null ? Number(row.min_lumpsum_amount) : null,
    supportsSip: toBool(row.supports_sip),
    supportsLumpsum: toBool(row.supports_lumpsum),
    investUrl: row.invest_url || null,
    features: parseJsonList(row.features),
    highlights: row.highlights || null,
    displayPriority: row.display_priority ?? 0,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const emptyToNull = (value) => (value === '' || value === undefined ? null : value);

const logoUrlSchema = z.preprocess(
  emptyToNull,
  z.union([z.string().url(), z.string().regex(/^\/uploads\/.+/i), z.null()]).optional(),
);

function isLogoImage(file) {
  const mime = (file.mimetype || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  const ext = extname(file.originalname || '').toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(ext);
}

function wrapMulter(uploadMiddleware) {
  return (req, res, next) => {
    uploadMiddleware(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        err.status = 413;
        err.message = 'Logo image must be 2 MB or smaller';
      } else if (!err.status) err.status = 400;
      next(err);
    });
  };
}

const logoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        const dir = getUploadDir();
        mkdirSync(dir, { recursive: true });
        cb(null, dir);
      } catch (err) {
        cb(err);
      }
    },
    filename: (_req, file, cb) => {
      const ext = extname(file.originalname || '') || '.png';
      cb(null, `mutual-fund-logo-${Date.now()}-${newId().slice(0, 8)}${ext.replace(/[^a-zA-Z0-9.]/g, '').slice(0, 8) || '.png'}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (isLogoImage(file)) return cb(null, true);
    const err = new Error('Only image files are allowed');
    err.status = 400;
    cb(err);
  },
});

const FundSchema = z.object({
  features: z.union([z.array(z.string()), z.string()]).optional(),
  categories: z.union([z.array(z.string()), z.string()]).optional(),
  amcId: z.preprocess(emptyToNull, z.union([z.string().min(1), z.null()]).optional()),
  amcName: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  logoUrl: logoUrlSchema,
  returns1y: z.coerce.number().optional().nullable(),
  returns3y: z.coerce.number().optional().nullable(),
  returns5y: z.coerce.number().optional().nullable(),
  riskLevel: z.enum(['low', 'low_to_moderate', 'moderate', 'moderately_high', 'high', 'very_high']).optional().nullable(),
  expenseRatio: z.coerce.number().optional().nullable(),
  fundManager: z.string().optional().nullable(),
  aumCrores: z.coerce.number().optional().nullable(),
  rating: z.coerce.number().optional().nullable(),
  minSipAmount: z.coerce.number().optional().nullable(),
  minLumpsumAmount: z.coerce.number().optional().nullable(),
  supportsSip: z.coerce.boolean().optional(),
  supportsLumpsum: z.coerce.boolean().optional(),
  investUrl: z.preprocess(emptyToNull, z.union([z.string().url(), z.null()]).optional()),
  highlights: z.string().optional().nullable(),
  displayPriority: z.coerce.number().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

function normalizeBody(body) {
  const parsed = FundSchema.parse(body);
  return {
    amc_id: parsed.amcId || null,
    amc_name: parsed.amcName,
    name: parsed.name,
    slug: parsed.slug || slugify(parsed.name),
    description: parsed.description || null,
    logo_url: parsed.logoUrl || null,
    categories: JSON.stringify(normalizeCategoryList(parsed.categories)),
    returns_1y: parsed.returns1y ?? null,
    returns_3y: parsed.returns3y ?? null,
    returns_5y: parsed.returns5y ?? null,
    risk_level: parsed.riskLevel || null,
    expense_ratio: parsed.expenseRatio ?? null,
    fund_manager: parsed.fundManager?.trim() || null,
    aum_crores: parsed.aumCrores ?? null,
    rating: parsed.rating ?? null,
    min_sip_amount: parsed.minSipAmount ?? null,
    min_lumpsum_amount: parsed.minLumpsumAmount ?? null,
    supports_sip: parsed.supportsSip ?? true,
    supports_lumpsum: parsed.supportsLumpsum ?? true,
    invest_url: parsed.investUrl || null,
    features: JSON.stringify(parseJsonList(parsed.features)),
    highlights: parsed.highlights?.trim() || null,
    display_priority: parsed.displayPriority ?? 0,
    status: parsed.status || 'active',
  };
}

function parseNumericRange(value) {
  if (!value || value === 'all') return null;
  const parts = String(value).split('-');
  const min = parts[0] ? Number(parts[0].replace('+', '')) : null;
  const max = parts[1] ? Number(parts[1]) : null;
  if (value.endsWith('+') && parts.length === 1) return { min: Number(parts[0].replace('+', '')) };
  return { min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null };
}

function buildListQuery(query) {
  const conditions = [];
  const params = {};

  if (query.includeInactive !== 'true') conditions.push("status = 'active'");

  if (query.search) {
    conditions.push(`(
      LOWER(name) LIKE :search OR
      LOWER(amc_name) LIKE :search OR
      LOWER(COALESCE(fund_manager, '')) LIKE :search OR
      LOWER(COALESCE(description, '')) LIKE :search
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

  if (query.riskLevel && query.riskLevel !== 'all' && RISK_SLUGS.has(String(query.riskLevel))) {
    conditions.push('risk_level = :riskLevel');
    params.riskLevel = String(query.riskLevel);
  }

  const expenseRange = parseNumericRange(query.expenseRatio);
  if (expenseRange) {
    if (expenseRange.min != null) {
      conditions.push('expense_ratio >= :expenseMin');
      params.expenseMin = expenseRange.min;
    }
    if (expenseRange.max != null) {
      conditions.push('expense_ratio <= :expenseMax');
      params.expenseMax = expenseRange.max;
    }
  }

  const rating = query.rating;
  if (rating && rating !== 'all') {
    if (rating === '4+') {
      conditions.push('rating >= 4');
    } else if (rating === '4.5+') {
      conditions.push('rating >= 4.5');
    } else if (rating === '5') {
      conditions.push('rating >= 5');
    }
  }

  const returns = query.returns;
  if (returns === '1y_10+') conditions.push('returns_1y >= 10');
  if (returns === '1y_15+') conditions.push('returns_1y >= 15');
  if (returns === '3y_12+') conditions.push('returns_3y >= 12');
  if (returns === '5y_12+') conditions.push('returns_5y >= 12');

  if (query.supportsSip === 'true') conditions.push('supports_sip = TRUE');
  if (query.supportsLumpsum === 'true') conditions.push('supports_lumpsum = TRUE');

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

mutualFundsRouter.get('/taxonomy', async (_req, res) => {
  res.json(getMutualFundTaxonomy());
});

const MutualFundCalculateSchema = z.object({
  investmentMode: z.enum(['sip', 'lumpsum']).optional(),
  monthlyInvestment: z.coerce.number().optional(),
  lumpsumAmount: z.coerce.number().optional(),
  principal: z.coerce.number().optional(),
  expectedReturn: z.coerce.number().optional(),
  annualReturn: z.coerce.number().optional(),
  expenseRatio: z.coerce.number().optional(),
  tenureYears: z.coerce.number().optional(),
});

mutualFundsRouter.post('/calculate', async (req, res, next) => {
  try {
    const input = MutualFundCalculateSchema.parse(req.body);
    res.json(calculateMutualFundReturns(input));
  } catch (err) {
    next(err);
  }
});

mutualFundsRouter.get('/', async (req, res, next) => {
  try {
    await ensureMutualFundSchema();
    const pool = getPool();
    const { where, params } = buildListQuery(req.query);
    const [rows] = await pool.execute(
      `SELECT * FROM mutual_funds ${where} ORDER BY display_priority DESC, rating DESC NULLS LAST, amc_name ASC, name ASC`,
      params,
    );
    res.json(rows.map(formatFundRow));
  } catch (err) {
    next(err);
  }
});

mutualFundsRouter.get('/:id', async (req, res, next) => {
  try {
    await ensureMutualFundSchema();
    const pool = getPool();
    const [[row]] = await pool.execute(`SELECT * FROM mutual_funds WHERE id = :id LIMIT 1`, { id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Mutual fund not found' });
    res.json(formatFundRow(row));
  } catch (err) {
    next(err);
  }
});

mutualFundsRouter.post('/', authenticate, authorize({ resource: 'banks', action: 'update' }), async (req, res, next) => {
  try {
    await ensureMutualFundSchema();
    const pool = getPool();
    const input = normalizeBody(req.body);
    const id = newId();
    await pool.execute(
      `INSERT INTO mutual_funds (
        id, amc_id, amc_name, name, slug, description, logo_url, categories,
        returns_1y, returns_3y, returns_5y, risk_level, expense_ratio, fund_manager,
        aum_crores, rating, min_sip_amount, min_lumpsum_amount,
        supports_sip, supports_lumpsum, invest_url, features, highlights, display_priority, status
      ) VALUES (
        :id, :amc_id, :amc_name, :name, :slug, :description, :logo_url, :categories::jsonb,
        :returns_1y, :returns_3y, :returns_5y, :risk_level, :expense_ratio, :fund_manager,
        :aum_crores, :rating, :min_sip_amount, :min_lumpsum_amount,
        :supports_sip, :supports_lumpsum, :invest_url, :features, :highlights, :display_priority, :status
      )`,
      { id, ...input },
    );
    const [[row]] = await pool.execute(`SELECT * FROM mutual_funds WHERE id = :id`, { id });
    res.status(201).json(formatFundRow(row));
  } catch (err) {
    next(err);
  }
});

mutualFundsRouter.put('/:id', authenticate, authorize({ resource: 'banks', action: 'update' }), async (req, res, next) => {
  try {
    await ensureMutualFundSchema();
    const pool = getPool();
    const input = normalizeBody(req.body);
    const [[existing]] = await pool.execute(`SELECT id FROM mutual_funds WHERE id = :id LIMIT 1`, { id: req.params.id });
    if (!existing) return res.status(404).json({ error: 'Mutual fund not found' });
    await pool.execute(
      `UPDATE mutual_funds SET
        amc_id = :amc_id, amc_name = :amc_name, name = :name, slug = :slug,
        description = :description, logo_url = :logo_url, categories = :categories::jsonb,
        returns_1y = :returns_1y, returns_3y = :returns_3y, returns_5y = :returns_5y,
        risk_level = :risk_level, expense_ratio = :expense_ratio, fund_manager = :fund_manager,
        aum_crores = :aum_crores, rating = :rating,
        min_sip_amount = :min_sip_amount, min_lumpsum_amount = :min_lumpsum_amount,
        supports_sip = :supports_sip, supports_lumpsum = :supports_lumpsum,
        invest_url = :invest_url, features = :features, highlights = :highlights,
        display_priority = :display_priority, status = :status
       WHERE id = :id`,
      { id: req.params.id, ...input },
    );
    const [[row]] = await pool.execute(`SELECT * FROM mutual_funds WHERE id = :id`, { id: req.params.id });
    res.json(formatFundRow(row));
  } catch (err) {
    next(err);
  }
});

mutualFundsRouter.post('/:id/logo', authenticate, authorize({ resource: 'banks', action: 'update' }), wrapMulter(logoUpload.single('logo')), async (req, res, next) => {
  try {
    await ensureMutualFundSchema();
    if (!req.file) return res.status(400).json({ error: 'Logo image file is required (field name: logo)' });
    const pool = getPool();
    const logoUrl = `/uploads/${req.file.filename}`;
    await pool.execute(`UPDATE mutual_funds SET logo_url = :logo_url WHERE id = :id`, { id: req.params.id, logo_url: logoUrl });
    const [[row]] = await pool.execute(`SELECT * FROM mutual_funds WHERE id = :id`, { id: req.params.id });
    if (!row) return res.status(404).json({ error: 'Mutual fund not found' });
    res.json(formatFundRow(row));
  } catch (err) {
    next(err);
  }
});

mutualFundsRouter.delete('/:id', authenticate, authorize({ resource: 'banks', action: 'update' }), async (req, res, next) => {
  try {
    await ensureMutualFundSchema();
    const pool = getPool();
    const [result] = await pool.execute(`DELETE FROM mutual_funds WHERE id = :id`, { id: req.params.id });
    if (!result.affectedRows) return res.status(404).json({ error: 'Mutual fund not found' });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export { MUTUAL_FUND_CATEGORY_SLUGS };
