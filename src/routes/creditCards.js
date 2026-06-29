import { Router } from 'express';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { ensureCreditCardSchema } from '../db/ensureCreditCardSchema.js';
import { newId } from '../lib/ids.js';
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

const CardSchema = z.object({
  features: z.union([z.array(z.string()), z.string()]).optional(),
  advantages: z.union([z.array(z.string()), z.string()]).optional(),
  benefits: z.union([z.array(z.string()), z.string()]).optional(),
  bankId: z.preprocess(emptyToNull, z.union([z.string().min(1), z.null()]).optional()),
  bankName: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  logoUrl: z.string().optional().nullable(),
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
