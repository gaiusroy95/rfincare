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

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function formatCardRow(row) {
  return {
    id: row.id,
    bankId: row.bank_id || null,
    bankName: row.bank_name,
    name: row.name,
    slug: row.slug,
    description: row.description,
    logoUrl: row.logo_url,
    cardNetwork: row.card_network,
    annualFee: row.annual_fee != null ? Number(row.annual_fee) : null,
    joiningFee: row.joining_fee != null ? Number(row.joining_fee) : null,
    interestRate: row.interest_rate != null ? Number(row.interest_rate) : null,
    latePaymentFee: row.late_payment_fee,
    otherCharges: row.other_charges,
    features: parseJsonList(row.features),
    advantages: parseJsonList(row.advantages),
    benefits: parseJsonList(row.benefits),
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
    annual_fee: parsed.annualFee ?? null,
    joining_fee: parsed.joiningFee ?? null,
    interest_rate: parsed.interestRate ?? null,
    late_payment_fee: parsed.latePaymentFee || null,
    other_charges: parsed.otherCharges || null,
    features: JSON.stringify(parseJsonList(parsed.features)),
    advantages: JSON.stringify(parseJsonList(parsed.advantages)),
    benefits: JSON.stringify(parseJsonList(parsed.benefits)),
    apply_url: parsed.applyUrl || null,
    display_priority: parsed.displayPriority ?? 0,
    status: parsed.status || 'active',
  };
}

creditCardsRouter.get('/', async (req, res, next) => {
  try {
    await ensureCreditCardSchema();
    const pool = getPool();
    const includeInactive = req.query.includeInactive === 'true';
    const [rows] = await pool.execute(
      `SELECT * FROM credit_cards
       ${includeInactive ? '' : "WHERE status = 'active'"}
       ORDER BY display_priority DESC, bank_name ASC, name ASC`,
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
          annual_fee, joining_fee, interest_rate, late_payment_fee, other_charges,
          features, advantages, benefits, apply_url, display_priority, status
        ) VALUES (
          :id, :bank_id, :bank_name, :name, :slug, :description, :logo_url, :card_network,
          :annual_fee, :joining_fee, :interest_rate, :late_payment_fee, :other_charges,
          :features, :advantages, :benefits, :apply_url, :display_priority, :status
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
          annual_fee = :annual_fee,
          joining_fee = :joining_fee,
          interest_rate = :interest_rate,
          late_payment_fee = :late_payment_fee,
          other_charges = :other_charges,
          features = :features,
          advantages = :advantages,
          benefits = :benefits,
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
