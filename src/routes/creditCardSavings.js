import { Router } from 'express';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { ensureCreditCardSchema } from '../db/ensureCreditCardSchema.js';
import { listCredLaxmiCategories } from '../lib/credLaxmiCategories.js';
import { rankCredLaxmiCards } from '../lib/credLaxmiCalculator.js';
import {
  buildCredLaxmiTop5Recommendations,
  CREDLAXMI_RECOMMENDATION_LABELS,
} from '../lib/credLaxmiSaverRecommendations.js';

export const creditCardSavingsRouter = Router();

const SpendItemSchema = z.object({
  categoryCode: z.string().min(1).optional(),
  category_code: z.string().min(1).optional(),
  amount: z.coerce.number().min(0).optional(),
  spend: z.coerce.number().min(0).optional(),
  period: z.enum(['monthly', 'quarterly', 'annual', 'yearly']).optional(),
  frequency: z.enum(['monthly', 'quarterly', 'annual', 'yearly']).optional(),
}).refine((v) => v.categoryCode || v.category_code, { message: 'categoryCode required' });

const CardSchema = z.object({
  id: z.string().optional(),
  cardId: z.string().optional(),
  name: z.string().optional(),
  bankName: z.string().optional(),
  annualFee: z.coerce.number().optional(),
  joiningFee: z.coerce.number().optional(),
  annualFeeWaiverSpendThreshold: z.coerce.number().optional(),
  loungeAccess: z.boolean().optional(),
  rewardRules: z.any().optional(),
  reward_rules: z.any().optional(),
}).passthrough();

const RecommendSchema = z.object({
  spendPeriod: z.enum(['monthly', 'quarterly', 'annual']).default('monthly'),
  spends: z.array(SpendItemSchema).min(1).max(30),
  cards: z.array(CardSchema).min(1).max(12),
});

const SaverSchema = z.object({
  spendPeriod: z.enum(['monthly', 'quarterly', 'annual']).default('monthly'),
  spends: z.array(SpendItemSchema).min(1).max(40),
  /** Optional — when omitted, all active cards are loaded from catalog. */
  cards: z.array(CardSchema).max(80).optional(),
});

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapDbCard(row) {
  if (!row) return null;
  const categories = parseJson(row.categories, []);
  const benefits = String(row.benefits || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    id: row.id,
    cardId: row.id,
    name: row.name,
    bankName: row.bank_name,
    bankId: row.bank_id,
    categories: Array.isArray(categories) ? categories : [],
    annualFee: Number(row.annual_fee) || 0,
    joiningFee: Number(row.joining_fee) || 0,
    annualFeeWaiverSpendThreshold: row.annual_fee_waiver_spend_threshold != null
      ? Number(row.annual_fee_waiver_spend_threshold)
      : null,
    loungeAccess: Boolean(row.lounge_access),
    rewardRules: parseJson(row.reward_rules, null),
    logoUrl: row.logo_url,
    applyUrl: row.apply_url,
    keyBenefits: benefits,
    benefits,
    status: row.status,
  };
}

async function loadActiveCards() {
  await ensureCreditCardSchema();
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT * FROM credit_cards
     WHERE COALESCE(status, 'active') = 'active'
     ORDER BY display_priority DESC, bank_name ASC, name ASC
     LIMIT 80`,
  );
  return (rows || []).map(mapDbCard).filter(Boolean);
}

function normalizeSpends(spends, defaultPeriod) {
  return spends.map((s) => ({
    categoryCode: s.categoryCode || s.category_code,
    amount: s.amount ?? s.spend ?? 0,
    period: s.period || s.frequency || defaultPeriod,
  }));
}

creditCardSavingsRouter.get('/categories', (_req, res) => {
  res.json({
    categories: listCredLaxmiCategories(),
    household: listCredLaxmiCategories({ expenseType: 'HOUSEHOLD' }),
    business: listCredLaxmiCategories({ expenseType: 'BUSINESS' }),
    special: listCredLaxmiCategories({ expenseType: 'SPECIAL' }),
    recommendationLabels: CREDLAXMI_RECOMMENDATION_LABELS,
  });
});

creditCardSavingsRouter.get('/recommendation-labels', (_req, res) => {
  res.json({ labels: CREDLAXMI_RECOMMENDATION_LABELS });
});

/** Existing compare-board ranking (2–12 selected cards). Unchanged contract. */
creditCardSavingsRouter.post('/recommendation', async (req, res, next) => {
  try {
    const input = RecommendSchema.parse(req.body);
    const defaultPeriod = input.spendPeriod || 'monthly';
    const spends = normalizeSpends(input.spends, defaultPeriod);
    const result = rankCredLaxmiCards(input.cards, spends);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * CredLaxmi Credit Card Saver — diversified Top-5 recommendations.
 * Does not alter the compare-page `/recommendation` behaviour.
 */
creditCardSavingsRouter.post('/saver-recommendation', async (req, res, next) => {
  try {
    const input = SaverSchema.parse(req.body);
    const defaultPeriod = input.spendPeriod || 'monthly';
    const spends = normalizeSpends(input.spends, defaultPeriod);
    const cards = Array.isArray(input.cards) && input.cards.length
      ? input.cards
      : await loadActiveCards();

    if (!cards.length) {
      return res.status(404).json({
        error: 'No active credit cards are available for recommendations yet.',
      });
    }

    const result = buildCredLaxmiTop5Recommendations({
      cards,
      spendProfile: spends,
      spendPeriod: defaultPeriod,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});
