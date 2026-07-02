import { Router } from 'express';
import { mkdirSync } from 'node:fs';
import { extname } from 'node:path';
import multer from 'multer';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { ensureInsuranceSchema } from '../db/ensureInsuranceSchema.js';
import { newId } from '../lib/ids.js';
import { getUploadDir } from '../lib/uploadPaths.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import {
  getInsuranceTaxonomy,
  normalizeCategoryList,
  INSURANCE_CATEGORY_SLUGS,
  INSURANCE_SEGMENTS,
} from '../lib/insuranceTaxonomy.js';

export const insuranceProductsRouter = Router();

const SEGMENT_SLUGS = new Set(INSURANCE_SEGMENTS.map((s) => s.slug));

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

function formatProductRow(row) {
  const categories = parseCategories(row.categories);
  return {
    id: row.id,
    insurerId: row.insurer_id || null,
    insurerName: row.insurer_name,
    name: row.name,
    slug: row.slug,
    description: row.description,
    logoUrl: row.logo_url,
    segment: row.segment,
    categories,
    premiumFrom: row.premium_from != null ? Number(row.premium_from) : null,
    premiumTo: row.premium_to != null ? Number(row.premium_to) : null,
    premiumUnit: row.premium_unit || 'yearly',
    sumInsuredFrom: row.sum_insured_from != null ? Number(row.sum_insured_from) : null,
    sumInsuredTo: row.sum_insured_to != null ? Number(row.sum_insured_to) : null,
    coverageTermYears: row.coverage_term_years != null ? Number(row.coverage_term_years) : null,
    waitingPeriodDays: row.waiting_period_days != null ? Number(row.waiting_period_days) : null,
    claimSettlementRatio: row.claim_settlement_ratio != null ? Number(row.claim_settlement_ratio) : null,
    cashlessHospitals: row.cashless_hospitals != null ? Number(row.cashless_hospitals) : null,
    taxBenefit80c: toBool(row.tax_benefit_80c),
    taxBenefit80d: toBool(row.tax_benefit_80d),
    supportsNewPolicy: toBool(row.supports_new_policy),
    supportsRenewal: toBool(row.supports_renewal),
    supportsClaimAssistance: toBool(row.supports_claim_assistance),
    newPolicyUrl: row.new_policy_url || null,
    renewalUrl: row.renewal_url || null,
    claimAssistanceUrl: row.claim_assistance_url || null,
    purchaseEnabled: toBool(row.purchase_enabled),
    purchaseMode: row.purchase_mode || 'redirect',
    insurerProviderCode: row.insurer_provider_code || null,
    insurerProductCode: row.insurer_product_code || null,
    insurerPlanCode: row.insurer_plan_code || null,
    paymentAccountCode: row.payment_account_code || null,
    demographicMapping:
      typeof row.demographic_mapping === 'object'
        ? row.demographic_mapping
        : row.demographic_mapping
          ? JSON.parse(row.demographic_mapping)
          : {},
    features: parseJsonList(row.features),
    benefits: parseJsonList(row.benefits),
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
      } else if (!err.status) {
        err.status = 400;
      }
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
      const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, '').slice(0, 8) || '.png';
      cb(null, `insurance-logo-${Date.now()}-${newId().slice(0, 8)}${safeExt}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (isLogoImage(file)) return cb(null, true);
    const err = new Error('Only image files (JPEG, PNG, GIF, WebP, SVG) are allowed');
    err.status = 400;
    cb(err);
  },
});

const ProductSchema = z.object({
  features: z.union([z.array(z.string()), z.string()]).optional(),
  benefits: z.union([z.array(z.string()), z.string()]).optional(),
  categories: z.union([z.array(z.string()), z.string()]).optional(),
  insurerId: z.preprocess(emptyToNull, z.union([z.string().min(1), z.null()]).optional()),
  insurerName: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  logoUrl: logoUrlSchema,
  segment: z.enum(['life', 'health', 'motor']),
  premiumFrom: z.coerce.number().optional().nullable(),
  premiumTo: z.coerce.number().optional().nullable(),
  premiumUnit: z.enum(['monthly', 'yearly']).optional(),
  sumInsuredFrom: z.coerce.number().optional().nullable(),
  sumInsuredTo: z.coerce.number().optional().nullable(),
  coverageTermYears: z.coerce.number().optional().nullable(),
  waitingPeriodDays: z.coerce.number().optional().nullable(),
  claimSettlementRatio: z.coerce.number().optional().nullable(),
  cashlessHospitals: z.coerce.number().optional().nullable(),
  taxBenefit80c: z.coerce.boolean().optional(),
  taxBenefit80d: z.coerce.boolean().optional(),
  supportsNewPolicy: z.coerce.boolean().optional(),
  supportsRenewal: z.coerce.boolean().optional(),
  supportsClaimAssistance: z.coerce.boolean().optional(),
  newPolicyUrl: z.preprocess(emptyToNull, z.union([z.string().url(), z.null()]).optional()),
  renewalUrl: z.preprocess(emptyToNull, z.union([z.string().url(), z.null()]).optional()),
  claimAssistanceUrl: z.preprocess(emptyToNull, z.union([z.string().url(), z.null()]).optional()),
  purchaseEnabled: z.coerce.boolean().optional(),
  purchaseMode: z.enum(['api', 'redirect', 'manual']).optional(),
  insurerProviderCode: z.preprocess(emptyToNull, z.union([z.string().min(1), z.null()]).optional()),
  insurerProductCode: z.preprocess(emptyToNull, z.union([z.string().min(1), z.null()]).optional()),
  insurerPlanCode: z.preprocess(emptyToNull, z.union([z.string().min(1), z.null()]).optional()),
  paymentAccountCode: z.preprocess(emptyToNull, z.union([z.string().min(1), z.null()]).optional()),
  demographicMapping: z.record(z.unknown()).optional(),
  highlights: z.string().optional().nullable(),
  displayPriority: z.coerce.number().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

function normalizeBody(body) {
  const parsed = ProductSchema.parse(body);
  return {
    insurer_id: parsed.insurerId || null,
    insurer_name: parsed.insurerName,
    name: parsed.name,
    slug: parsed.slug || slugify(parsed.name),
    description: parsed.description || null,
    logo_url: parsed.logoUrl || null,
    segment: parsed.segment,
    categories: JSON.stringify(normalizeCategoryList(parsed.categories)),
    premium_from: parsed.premiumFrom ?? null,
    premium_to: parsed.premiumTo ?? null,
    premium_unit: parsed.premiumUnit || 'yearly',
    sum_insured_from: parsed.sumInsuredFrom ?? null,
    sum_insured_to: parsed.sumInsuredTo ?? null,
    coverage_term_years: parsed.coverageTermYears ?? null,
    waiting_period_days: parsed.waitingPeriodDays ?? null,
    claim_settlement_ratio: parsed.claimSettlementRatio ?? null,
    cashless_hospitals: parsed.cashlessHospitals ?? null,
    tax_benefit_80c: parsed.taxBenefit80c ?? false,
    tax_benefit_80d: parsed.taxBenefit80d ?? false,
    supports_new_policy: parsed.supportsNewPolicy ?? true,
    supports_renewal: parsed.supportsRenewal ?? false,
    supports_claim_assistance: parsed.supportsClaimAssistance ?? false,
    new_policy_url: parsed.newPolicyUrl || null,
    renewal_url: parsed.renewalUrl || null,
    claim_assistance_url: parsed.claimAssistanceUrl || null,
    purchase_enabled: parsed.purchaseEnabled ?? false,
    purchase_mode: parsed.purchaseMode || 'redirect',
    insurer_provider_code: parsed.insurerProviderCode || null,
    insurer_product_code: parsed.insurerProductCode || null,
    insurer_plan_code: parsed.insurerPlanCode || null,
    payment_account_code: parsed.paymentAccountCode || null,
    demographic_mapping: JSON.stringify(parsed.demographicMapping || {}),
    features: JSON.stringify(parseJsonList(parsed.features)),
    benefits: JSON.stringify(parseJsonList(parsed.benefits)),
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
      LOWER(insurer_name) LIKE :search OR
      LOWER(COALESCE(description, '')) LIKE :search OR
      LOWER(COALESCE(highlights, '')) LIKE :search
    )`);
    params.search = `%${String(query.search).toLowerCase()}%`;
  }

  const segment = query.segment;
  if (segment && segment !== 'all' && SEGMENT_SLUGS.has(String(segment))) {
    conditions.push('segment = :segment');
    params.segment = String(segment);
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

  const service = query.service;
  if (service === 'new_policy') conditions.push('supports_new_policy = TRUE');
  if (service === 'renewal') conditions.push('supports_renewal = TRUE');
  if (service === 'claim_assistance') conditions.push('supports_claim_assistance = TRUE');

  const premiumRange = parseNumericRange(query.premium);
  if (premiumRange) {
    if (premiumRange.min != null) {
      conditions.push('(premium_from IS NULL OR premium_from >= :premiumMin OR premium_to >= :premiumMin)');
      params.premiumMin = premiumRange.min;
    }
    if (premiumRange.max != null) {
      conditions.push('(premium_from IS NULL OR premium_from <= :premiumMax)');
      params.premiumMax = premiumRange.max;
    }
  }

  const sumInsuredRange = parseNumericRange(query.sumInsured);
  if (sumInsuredRange) {
    if (sumInsuredRange.min != null) {
      conditions.push('(sum_insured_to IS NULL OR sum_insured_to >= :sumInsuredMin OR sum_insured_from >= :sumInsuredMin)');
      params.sumInsuredMin = sumInsuredRange.min;
    }
    if (sumInsuredRange.max != null) {
      conditions.push('(sum_insured_from IS NULL OR sum_insured_from <= :sumInsuredMax)');
      params.sumInsuredMax = sumInsuredRange.max;
    }
  }

  if (query.taxBenefit80c === 'true') conditions.push('tax_benefit_80c = TRUE');
  if (query.taxBenefit80d === 'true') conditions.push('tax_benefit_80d = TRUE');

  if (query.claimSettlementMin) {
    const min = Number(query.claimSettlementMin);
    if (Number.isFinite(min)) {
      conditions.push('claim_settlement_ratio >= :csrMin');
      params.csrMin = min;
    }
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

insuranceProductsRouter.get('/taxonomy', async (_req, res) => {
  res.json(getInsuranceTaxonomy());
});

insuranceProductsRouter.get(
  '/provider-configs',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (_req, res, next) => {
    try {
      await ensureInsuranceSchema();
      const pool = getPool();
      const [rows] = await pool.execute(
        `SELECT * FROM insurance_provider_configs ORDER BY provider_name ASC, provider_code ASC`,
      );
      res.json(rows.map((row) => ({
        id: row.id,
        providerCode: row.provider_code,
        providerName: row.provider_name,
        integrationMode: row.integration_mode,
        baseUrl: row.base_url,
        authType: row.auth_type,
        apiKey: row.api_key || '',
        apiSecret: row.api_secret || '',
        webhookSecret: row.webhook_secret || '',
        paymentAccountCode: row.payment_account_code || '',
        requestConfig:
          typeof row.request_config === 'object'
            ? row.request_config
            : row.request_config
              ? JSON.parse(row.request_config)
              : {},
        status: row.status,
      })));
    } catch (err) {
      next(err);
    }
  },
);

insuranceProductsRouter.get('/', async (req, res, next) => {
  try {
    await ensureInsuranceSchema();
    const pool = getPool();
    const { where, params } = buildListQuery(req.query);
    const [rows] = await pool.execute(
      `SELECT * FROM insurance_products
       ${where}
       ORDER BY display_priority DESC, insurer_name ASC, name ASC`,
      params,
    );
    res.json(rows.map(formatProductRow));
  } catch (err) {
    next(err);
  }
});

insuranceProductsRouter.get('/:id', async (req, res, next) => {
  try {
    await ensureInsuranceSchema();
    const pool = getPool();
    const [[row]] = await pool.execute(
      `SELECT * FROM insurance_products WHERE id = :id LIMIT 1`,
      { id: req.params.id },
    );
    if (!row) return res.status(404).json({ error: 'Insurance product not found' });
    res.json(formatProductRow(row));
  } catch (err) {
    next(err);
  }
});

insuranceProductsRouter.post(
  '/',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureInsuranceSchema();
      const pool = getPool();
      const input = normalizeBody(req.body);
      const id = newId();
      await pool.execute(
        `INSERT INTO insurance_products (
          id, insurer_id, insurer_name, name, slug, description, logo_url, segment, categories,
          premium_from, premium_to, premium_unit, sum_insured_from, sum_insured_to,
          coverage_term_years, waiting_period_days, claim_settlement_ratio, cashless_hospitals,
          tax_benefit_80c, tax_benefit_80d,
          supports_new_policy, supports_renewal, supports_claim_assistance,
          new_policy_url, renewal_url, claim_assistance_url,
          purchase_enabled, purchase_mode, insurer_provider_code, insurer_product_code,
          insurer_plan_code, payment_account_code, demographic_mapping,
          features, benefits, highlights, display_priority, status
        ) VALUES (
          :id, :insurer_id, :insurer_name, :name, :slug, :description, :logo_url, :segment, :categories::jsonb,
          :premium_from, :premium_to, :premium_unit, :sum_insured_from, :sum_insured_to,
          :coverage_term_years, :waiting_period_days, :claim_settlement_ratio, :cashless_hospitals,
          :tax_benefit_80c, :tax_benefit_80d,
          :supports_new_policy, :supports_renewal, :supports_claim_assistance,
          :new_policy_url, :renewal_url, :claim_assistance_url,
          :purchase_enabled, :purchase_mode, :insurer_provider_code, :insurer_product_code,
          :insurer_plan_code, :payment_account_code, :demographic_mapping::jsonb,
          :features, :benefits, :highlights, :display_priority, :status
        )`,
        { id, ...input },
      );
      const [[row]] = await pool.execute(`SELECT * FROM insurance_products WHERE id = :id`, { id });
      res.status(201).json(formatProductRow(row));
    } catch (err) {
      next(err);
    }
  },
);

insuranceProductsRouter.put(
  '/:id',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureInsuranceSchema();
      const pool = getPool();
      const input = normalizeBody(req.body);
      const [[existing]] = await pool.execute(
        `SELECT id FROM insurance_products WHERE id = :id LIMIT 1`,
        { id: req.params.id },
      );
      if (!existing) return res.status(404).json({ error: 'Insurance product not found' });

      await pool.execute(
        `UPDATE insurance_products SET
          insurer_id = :insurer_id,
          insurer_name = :insurer_name,
          name = :name,
          slug = :slug,
          description = :description,
          logo_url = :logo_url,
          segment = :segment,
          categories = :categories::jsonb,
          premium_from = :premium_from,
          premium_to = :premium_to,
          premium_unit = :premium_unit,
          sum_insured_from = :sum_insured_from,
          sum_insured_to = :sum_insured_to,
          coverage_term_years = :coverage_term_years,
          waiting_period_days = :waiting_period_days,
          claim_settlement_ratio = :claim_settlement_ratio,
          cashless_hospitals = :cashless_hospitals,
          tax_benefit_80c = :tax_benefit_80c,
          tax_benefit_80d = :tax_benefit_80d,
          supports_new_policy = :supports_new_policy,
          supports_renewal = :supports_renewal,
          supports_claim_assistance = :supports_claim_assistance,
          new_policy_url = :new_policy_url,
          renewal_url = :renewal_url,
          claim_assistance_url = :claim_assistance_url,
          purchase_enabled = :purchase_enabled,
          purchase_mode = :purchase_mode,
          insurer_provider_code = :insurer_provider_code,
          insurer_product_code = :insurer_product_code,
          insurer_plan_code = :insurer_plan_code,
          payment_account_code = :payment_account_code,
          demographic_mapping = :demographic_mapping::jsonb,
          features = :features,
          benefits = :benefits,
          highlights = :highlights,
          display_priority = :display_priority,
          status = :status
         WHERE id = :id`,
        { id: req.params.id, ...input },
      );
      const [[row]] = await pool.execute(`SELECT * FROM insurance_products WHERE id = :id`, { id: req.params.id });
      res.json(formatProductRow(row));
    } catch (err) {
      next(err);
    }
  },
);

const ProviderConfigSchema = z.object({
  providerCode: z.string().min(2),
  providerName: z.string().min(2),
  integrationMode: z.enum(['demo', 'generic_api']).optional(),
  baseUrl: z.preprocess(emptyToNull, z.union([z.string().url(), z.null()]).optional()),
  authType: z.enum(['bearer', 'basic', 'x_api_key']).optional(),
  apiKey: z.string().optional(),
  apiSecret: z.string().optional(),
  webhookSecret: z.string().optional(),
  paymentAccountCode: z.string().optional(),
  requestConfig: z.record(z.unknown()).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

insuranceProductsRouter.post(
  '/provider-configs',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      const input = ProviderConfigSchema.parse(req.body || {});
      const pool = getPool();
      const id = newId();
      await pool.execute(
        `INSERT INTO insurance_provider_configs (
           id, provider_code, provider_name, integration_mode, base_url, auth_type,
           api_key, api_secret, webhook_secret, payment_account_code, request_config, status
         ) VALUES (
           :id, :provider_code, :provider_name, :integration_mode, :base_url, :auth_type,
           :api_key, :api_secret, :webhook_secret, :payment_account_code, :request_config::jsonb, :status
         )`,
        {
          id,
          provider_code: input.providerCode.trim(),
          provider_name: input.providerName.trim(),
          integration_mode: input.integrationMode || 'generic_api',
          base_url: input.baseUrl || null,
          auth_type: input.authType || 'bearer',
          api_key: input.apiKey || null,
          api_secret: input.apiSecret || null,
          webhook_secret: input.webhookSecret || null,
          payment_account_code: input.paymentAccountCode || null,
          request_config: JSON.stringify(input.requestConfig || {}),
          status: input.status || 'active',
        },
      );
      const [[row]] = await pool.execute(`SELECT * FROM insurance_provider_configs WHERE id = :id`, { id });
      res.status(201).json({
        id: row.id,
        providerCode: row.provider_code,
        providerName: row.provider_name,
        integrationMode: row.integration_mode,
        baseUrl: row.base_url,
        authType: row.auth_type,
        apiKey: row.api_key || '',
        apiSecret: row.api_secret || '',
        webhookSecret: row.webhook_secret || '',
        paymentAccountCode: row.payment_account_code || '',
        requestConfig: typeof row.request_config === 'object' ? row.request_config : JSON.parse(row.request_config || '{}'),
        status: row.status,
      });
    } catch (err) {
      next(err);
    }
  },
);

insuranceProductsRouter.put(
  '/provider-configs/:id',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      const input = ProviderConfigSchema.parse(req.body || {});
      const pool = getPool();
      await pool.execute(
        `UPDATE insurance_provider_configs SET
           provider_code = :provider_code,
           provider_name = :provider_name,
           integration_mode = :integration_mode,
           base_url = :base_url,
           auth_type = :auth_type,
           api_key = :api_key,
           api_secret = :api_secret,
           webhook_secret = :webhook_secret,
           payment_account_code = :payment_account_code,
           request_config = :request_config::jsonb,
           status = :status,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = :id`,
        {
          id: req.params.id,
          provider_code: input.providerCode.trim(),
          provider_name: input.providerName.trim(),
          integration_mode: input.integrationMode || 'generic_api',
          base_url: input.baseUrl || null,
          auth_type: input.authType || 'bearer',
          api_key: input.apiKey || null,
          api_secret: input.apiSecret || null,
          webhook_secret: input.webhookSecret || null,
          payment_account_code: input.paymentAccountCode || null,
          request_config: JSON.stringify(input.requestConfig || {}),
          status: input.status || 'active',
        },
      );
      const [[row]] = await pool.execute(`SELECT * FROM insurance_provider_configs WHERE id = :id`, { id: req.params.id });
      if (!row) return res.status(404).json({ error: 'Provider config not found' });
      res.json({
        id: row.id,
        providerCode: row.provider_code,
        providerName: row.provider_name,
        integrationMode: row.integration_mode,
        baseUrl: row.base_url,
        authType: row.auth_type,
        apiKey: row.api_key || '',
        apiSecret: row.api_secret || '',
        webhookSecret: row.webhook_secret || '',
        paymentAccountCode: row.payment_account_code || '',
        requestConfig: typeof row.request_config === 'object' ? row.request_config : JSON.parse(row.request_config || '{}'),
        status: row.status,
      });
    } catch (err) {
      next(err);
    }
  },
);

insuranceProductsRouter.post(
  '/:id/logo',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  wrapMulter(logoUpload.single('logo')),
  async (req, res, next) => {
    try {
      await ensureInsuranceSchema();
      if (!req.file) {
        return res.status(400).json({ error: 'Logo image file is required (field name: logo)' });
      }
      const pool = getPool();
      const [[existing]] = await pool.execute(
        `SELECT id FROM insurance_products WHERE id = :id LIMIT 1`,
        { id: req.params.id },
      );
      if (!existing) return res.status(404).json({ error: 'Insurance product not found' });

      const logoUrl = `/uploads/${req.file.filename}`;
      await pool.execute(
        `UPDATE insurance_products SET logo_url = :logo_url WHERE id = :id`,
        { id: req.params.id, logo_url: logoUrl },
      );
      const [[row]] = await pool.execute(`SELECT * FROM insurance_products WHERE id = :id`, { id: req.params.id });
      res.json(formatProductRow(row));
    } catch (err) {
      next(err);
    }
  },
);

insuranceProductsRouter.delete(
  '/:id',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureInsuranceSchema();
      const pool = getPool();
      const [result] = await pool.execute(`DELETE FROM insurance_products WHERE id = :id`, { id: req.params.id });
      if (!result.affectedRows) return res.status(404).json({ error: 'Insurance product not found' });
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);

export { INSURANCE_CATEGORY_SLUGS };
