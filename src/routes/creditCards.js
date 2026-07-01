import { Router } from 'express';
import { mkdirSync } from 'node:fs';
import { extname } from 'node:path';
import multer from 'multer';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { ensureCreditCardSchema } from '../db/ensureCreditCardSchema.js';
import { newId } from '../lib/ids.js';
import { getUploadDir } from '../lib/uploadPaths.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import {
  getCreditCardTaxonomy,
  normalizeCategoryList,
  CREDIT_CARD_CATEGORY_SLUGS,
} from '../lib/creditCardTaxonomy.js';

export const creditCardsRouter = Router();

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
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  return false;
}

function formatCardRow(row) {
  const categories = parseCategories(row.categories);
  const rewardPoints = row.reward_points ? String(row.reward_points).trim() : null;
  return {
    id: row.id,
    bankId: row.bank_id || null,
    bankName: row.bank_name,
    name: row.name,
    slug: row.slug,
    description: row.description,
    logoUrl: row.logo_url,
    cardNetwork: row.card_network,
    categories,
    annualFee: row.annual_fee != null ? Number(row.annual_fee) : null,
    joiningFee: row.joining_fee != null ? Number(row.joining_fee) : null,
    interestRate: row.interest_rate != null ? Number(row.interest_rate) : null,
    latePaymentFee: row.late_payment_fee,
    otherCharges: row.other_charges,
    features: parseJsonList(row.features),
    advantages: parseJsonList(row.advantages),
    benefits: parseJsonList(row.benefits),
    rewardPoints,
    hasRewardPoints: Boolean(rewardPoints),
    loungeAccess: toBool(row.lounge_access),
    loungeAccessDetails: row.lounge_access_details || null,
    fuelSurchargeWaiver: toBool(row.fuel_surcharge_waiver),
    movieBenefits: toBool(row.movie_benefits),
    movieBenefitsDetails: row.movie_benefits_details || null,
    diningBenefits: toBool(row.dining_benefits),
    diningBenefitsDetails: row.dining_benefits_details || null,
    insuranceCover: toBool(row.insurance_cover),
    insuranceCoverDetails: row.insurance_cover_details || null,
    forexCharges: row.forex_charges || null,
    emiConversion: toBool(row.emi_conversion),
    emiConversionDetails: row.emi_conversion_details || null,
    applyUrl: row.apply_url,
    displayPriority: row.display_priority ?? 0,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const emptyToNull = (value) => (value === '' || value === undefined ? null : value);

const logoUrlSchema = z.preprocess(
  emptyToNull,
  z
    .union([
      z.string().url(),
      z.string().regex(/^\/uploads\/.+/i),
      z.null(),
    ])
    .optional(),
);

function isCardLogoImage(file) {
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
      } else if (!err.status) {
        err.status = 400;
      }
      next(err);
    });
  };
}

const cardLogoUpload = multer({
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
      const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, '').slice(0, 8) || '.png';
      cb(null, `credit-card-logo-${Date.now()}-${newId().slice(0, 8)}${safeExt}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (isCardLogoImage(file)) return cb(null, true);
    const err = new Error('Only image files (JPEG, PNG, GIF, WebP, SVG) are allowed');
    err.status = 400;
    cb(err);
  },
});

const CardSchema = z.object({
  features: z.union([z.array(z.string()), z.string()]).optional(),
  advantages: z.union([z.array(z.string()), z.string()]).optional(),
  benefits: z.union([z.array(z.string()), z.string()]).optional(),
  categories: z.union([z.array(z.string()), z.string()]).optional(),
  bankId: z.preprocess(emptyToNull, z.union([z.string().min(1), z.null()]).optional()),
  bankName: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  logoUrl: logoUrlSchema,
  cardNetwork: z.string().optional().nullable(),
  annualFee: z.coerce.number().optional().nullable(),
  joiningFee: z.coerce.number().optional().nullable(),
  interestRate: z.coerce.number().optional().nullable(),
  latePaymentFee: z.string().optional().nullable(),
  otherCharges: z.string().optional().nullable(),
  rewardPoints: z.string().optional().nullable(),
  loungeAccess: z.coerce.boolean().optional(),
  loungeAccessDetails: z.string().optional().nullable(),
  fuelSurchargeWaiver: z.coerce.boolean().optional(),
  movieBenefits: z.coerce.boolean().optional(),
  movieBenefitsDetails: z.string().optional().nullable(),
  diningBenefits: z.coerce.boolean().optional(),
  diningBenefitsDetails: z.string().optional().nullable(),
  insuranceCover: z.coerce.boolean().optional(),
  insuranceCoverDetails: z.string().optional().nullable(),
  forexCharges: z.string().optional().nullable(),
  emiConversion: z.coerce.boolean().optional(),
  emiConversionDetails: z.string().optional().nullable(),
  applyUrl: z.preprocess(emptyToNull, z.union([z.string().url(), z.null()]).optional()),
  displayPriority: z.coerce.number().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

function normalizeBody(body) {
  const parsed = CardSchema.parse(body);
  return {
    bank_id: parsed.bankId || null,
    bank_name: parsed.bankName,
    name: parsed.name,
    slug: parsed.slug || slugify(parsed.name),
    description: parsed.description || null,
    logo_url: parsed.logoUrl || null,
    card_network: parsed.cardNetwork || null,
    categories: JSON.stringify(normalizeCategoryList(parsed.categories)),
    annual_fee: parsed.annualFee ?? null,
    joining_fee: parsed.joiningFee ?? null,
    interest_rate: parsed.interestRate ?? null,
    late_payment_fee: parsed.latePaymentFee || null,
    other_charges: parsed.otherCharges || null,
    features: JSON.stringify(parseJsonList(parsed.features)),
    advantages: JSON.stringify(parseJsonList(parsed.advantages)),
    benefits: JSON.stringify(parseJsonList(parsed.benefits)),
    reward_points: parsed.rewardPoints?.trim() || null,
    lounge_access: parsed.loungeAccess ?? false,
    lounge_access_details: parsed.loungeAccessDetails?.trim() || null,
    fuel_surcharge_waiver: parsed.fuelSurchargeWaiver ?? false,
    movie_benefits: parsed.movieBenefits ?? false,
    movie_benefits_details: parsed.movieBenefitsDetails?.trim() || null,
    dining_benefits: parsed.diningBenefits ?? false,
    dining_benefits_details: parsed.diningBenefitsDetails?.trim() || null,
    insurance_cover: parsed.insuranceCover ?? false,
    insurance_cover_details: parsed.insuranceCoverDetails?.trim() || null,
    forex_charges: parsed.forexCharges?.trim() || null,
    emi_conversion: parsed.emiConversion ?? false,
    emi_conversion_details: parsed.emiConversionDetails?.trim() || null,
    apply_url: parsed.applyUrl || null,
    display_priority: parsed.displayPriority ?? 0,
    status: parsed.status || 'active',
  };
}

function parseFeeRange(value) {
  if (!value || value === 'all') return null;
  if (value === 'free') return { free: true };
  const parts = String(value).split('-');
  const min = parts[0] ? Number(parts[0].replace('+', '')) : null;
  const max = parts[1] ? Number(parts[1]) : null;
  if (value.endsWith('+') && parts.length === 1) {
    return { min: Number(parts[0].replace('+', '')) };
  }
  return { min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null };
}

function buildListQuery(query) {
  const conditions = [];
  const params = {};

  const includeInactive = query.includeInactive === 'true';
  if (!includeInactive) {
    conditions.push("status = 'active'");
  }

  if (query.search) {
    conditions.push(`(
      LOWER(name) LIKE :search OR
      LOWER(bank_name) LIKE :search OR
      LOWER(COALESCE(description, '')) LIKE :search
    )`);
    params.search = `%${String(query.search).toLowerCase()}%`;
  }

  const category = query.category;
  if (category && category !== 'all') {
    const slugs = normalizeCategoryList(String(category).split(','));
    if (slugs.length === 1) {
      conditions.push(`categories @> :categoryJson::jsonb`);
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

  const annualFeeRange = parseFeeRange(query.annualFee);
  if (annualFeeRange?.free) {
    conditions.push('(annual_fee IS NOT NULL AND annual_fee = 0)');
  } else if (annualFeeRange) {
    if (annualFeeRange.min != null) {
      conditions.push('annual_fee >= :annualFeeMin');
      params.annualFeeMin = annualFeeRange.min;
    }
    if (annualFeeRange.max != null) {
      conditions.push('annual_fee <= :annualFeeMax');
      params.annualFeeMax = annualFeeRange.max;
    }
  }

  const joiningFeeRange = parseFeeRange(query.joiningFee);
  if (joiningFeeRange?.free) {
    conditions.push('(joining_fee IS NOT NULL AND joining_fee = 0)');
  } else if (joiningFeeRange) {
    if (joiningFeeRange.min != null) {
      conditions.push('joining_fee >= :joiningFeeMin');
      params.joiningFeeMin = joiningFeeRange.min;
    }
    if (joiningFeeRange.max != null) {
      conditions.push('joining_fee <= :joiningFeeMax');
      params.joiningFeeMax = joiningFeeRange.max;
    }
  }

  const boolFilters = [
    ['rewardPoints', 'reward_points IS NOT NULL AND TRIM(reward_points) <> \'\''],
    ['loungeAccess', 'lounge_access = TRUE'],
    ['fuelSurchargeWaiver', 'fuel_surcharge_waiver = TRUE'],
    ['movieBenefits', 'movie_benefits = TRUE'],
    ['diningBenefits', 'dining_benefits = TRUE'],
    ['insuranceCover', 'insurance_cover = TRUE'],
    ['emiConversion', 'emi_conversion = TRUE'],
  ];
  for (const [param, sql] of boolFilters) {
    if (query[param] === 'true' || query[param] === true) {
      conditions.push(sql);
    }
  }

  const forex = query.forexCharges;
  if (forex && forex !== 'all') {
    if (forex === 'zero') {
      conditions.push(`(
        LOWER(COALESCE(forex_charges, '')) LIKE '%zero%' OR
        LOWER(COALESCE(forex_charges, '')) LIKE '%nil%' OR
        LOWER(COALESCE(forex_charges, '')) LIKE '%0%' OR
        LOWER(COALESCE(forex_charges, '')) LIKE '%no markup%'
      )`);
    } else if (forex === 'under_2') {
      conditions.push(`(
        forex_charges IS NOT NULL AND (
          forex_charges ~ '^[0-9.]+' AND CAST(SUBSTRING(forex_charges FROM '^[0-9.]+') AS DECIMAL) < 2
        )
      )`);
    } else if (forex === 'under_3') {
      conditions.push(`(
        forex_charges IS NOT NULL AND (
          forex_charges ~ '^[0-9.]+' AND CAST(SUBSTRING(forex_charges FROM '^[0-9.]+') AS DECIMAL) < 3
        )
      )`);
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

creditCardsRouter.get('/taxonomy', async (_req, res) => {
  res.json(getCreditCardTaxonomy());
});

creditCardsRouter.get('/', async (req, res, next) => {
  try {
    await ensureCreditCardSchema();
    const pool = getPool();
    const { where, params } = buildListQuery(req.query);
    const [rows] = await pool.execute(
      `SELECT * FROM credit_cards
       ${where}
       ORDER BY display_priority DESC, bank_name ASC, name ASC`,
      params,
    );
    res.json(rows.map(formatCardRow));
  } catch (err) {
    next(err);
  }
});

creditCardsRouter.get('/:id', async (req, res, next) => {
  try {
    await ensureCreditCardSchema();
    const pool = getPool();
    const [[row]] = await pool.execute(
      `SELECT * FROM credit_cards WHERE id = :id LIMIT 1`,
      { id: req.params.id },
    );
    if (!row) return res.status(404).json({ error: 'Credit card not found' });
    res.json(formatCardRow(row));
  } catch (err) {
    next(err);
  }
});

creditCardsRouter.post(
  '/',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureCreditCardSchema();
      const pool = getPool();
      const input = normalizeBody(req.body);
      const id = newId();
      await pool.execute(
        `INSERT INTO credit_cards (
          id, bank_id, bank_name, name, slug, description, logo_url, card_network,
          categories, annual_fee, joining_fee, interest_rate, late_payment_fee, other_charges,
          features, advantages, benefits,
          reward_points, lounge_access, lounge_access_details,
          fuel_surcharge_waiver, movie_benefits, movie_benefits_details,
          dining_benefits, dining_benefits_details, insurance_cover, insurance_cover_details,
          forex_charges, emi_conversion, emi_conversion_details,
          apply_url, display_priority, status
        ) VALUES (
          :id, :bank_id, :bank_name, :name, :slug, :description, :logo_url, :card_network,
          :categories::jsonb, :annual_fee, :joining_fee, :interest_rate, :late_payment_fee, :other_charges,
          :features, :advantages, :benefits,
          :reward_points, :lounge_access, :lounge_access_details,
          :fuel_surcharge_waiver, :movie_benefits, :movie_benefits_details,
          :dining_benefits, :dining_benefits_details, :insurance_cover, :insurance_cover_details,
          :forex_charges, :emi_conversion, :emi_conversion_details,
          :apply_url, :display_priority, :status
        )`,
        { id, ...input },
      );
      const [[row]] = await pool.execute(`SELECT * FROM credit_cards WHERE id = :id`, { id });
      res.status(201).json(formatCardRow(row));
    } catch (err) {
      next(err);
    }
  },
);

creditCardsRouter.put(
  '/:id',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureCreditCardSchema();
      const pool = getPool();
      const input = normalizeBody(req.body);
      const [[existing]] = await pool.execute(
        `SELECT id FROM credit_cards WHERE id = :id LIMIT 1`,
        { id: req.params.id },
      );
      if (!existing) return res.status(404).json({ error: 'Credit card not found' });

      await pool.execute(
        `UPDATE credit_cards SET
          bank_id = :bank_id,
          bank_name = :bank_name,
          name = :name,
          slug = :slug,
          description = :description,
          logo_url = :logo_url,
          card_network = :card_network,
          categories = :categories::jsonb,
          annual_fee = :annual_fee,
          joining_fee = :joining_fee,
          interest_rate = :interest_rate,
          late_payment_fee = :late_payment_fee,
          other_charges = :other_charges,
          features = :features,
          advantages = :advantages,
          benefits = :benefits,
          reward_points = :reward_points,
          lounge_access = :lounge_access,
          lounge_access_details = :lounge_access_details,
          fuel_surcharge_waiver = :fuel_surcharge_waiver,
          movie_benefits = :movie_benefits,
          movie_benefits_details = :movie_benefits_details,
          dining_benefits = :dining_benefits,
          dining_benefits_details = :dining_benefits_details,
          insurance_cover = :insurance_cover,
          insurance_cover_details = :insurance_cover_details,
          forex_charges = :forex_charges,
          emi_conversion = :emi_conversion,
          emi_conversion_details = :emi_conversion_details,
          apply_url = :apply_url,
          display_priority = :display_priority,
          status = :status
         WHERE id = :id`,
        { id: req.params.id, ...input },
      );
      const [[row]] = await pool.execute(`SELECT * FROM credit_cards WHERE id = :id`, { id: req.params.id });
      res.json(formatCardRow(row));
    } catch (err) {
      next(err);
    }
  },
);

creditCardsRouter.post(
  '/:id/logo',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  wrapMulter(cardLogoUpload.single('logo')),
  async (req, res, next) => {
    try {
      await ensureCreditCardSchema();
      if (!req.file) {
        return res.status(400).json({ error: 'Logo image file is required (field name: logo)' });
      }
      const pool = getPool();
      const [[existing]] = await pool.execute(
        `SELECT id FROM credit_cards WHERE id = :id LIMIT 1`,
        { id: req.params.id },
      );
      if (!existing) return res.status(404).json({ error: 'Credit card not found' });

      const logoUrl = `/uploads/${req.file.filename}`;
      await pool.execute(
        `UPDATE credit_cards SET logo_url = :logo_url WHERE id = :id`,
        { id: req.params.id, logo_url: logoUrl },
      );
      const [[row]] = await pool.execute(`SELECT * FROM credit_cards WHERE id = :id`, { id: req.params.id });
      res.json(formatCardRow(row));
    } catch (err) {
      next(err);
    }
  },
);

creditCardsRouter.delete(
  '/:id',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureCreditCardSchema();
      const pool = getPool();
      const [result] = await pool.execute(`DELETE FROM credit_cards WHERE id = :id`, { id: req.params.id });
      if (!result.affectedRows) return res.status(404).json({ error: 'Credit card not found' });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

export { CREDIT_CARD_CATEGORY_SLUGS };
