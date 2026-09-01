import { Router } from 'express';
import { z } from 'zod';

import { listCredLaxmiCategories } from '../lib/credLaxmiCategories.js';
import { rankCredLaxmiCards } from '../lib/credLaxmiCalculator.js';

export const creditCardSavingsRouter = Router();

const SpendItemSchema = z.object({
  categoryCode: z.string().min(1).optional(),
  category_code: z.string().min(1).optional(),
  amount: z.coerce.number().min(0).optional(),
  spend: z.coerce.number().min(0).optional(),
  period: z.enum(['monthly', 'annual', 'yearly']).optional(),
  frequency: z.enum(['monthly', 'annual', 'yearly']).optional(),
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
  spendPeriod: z.enum(['monthly', 'annual']).default('monthly'),
  spends: z.array(SpendItemSchema).min(1).max(30),
  cards: z.array(CardSchema).min(1).max(12),
});

creditCardSavingsRouter.get('/categories', (_req, res) => {
  res.json({
    categories: listCredLaxmiCategories(),
    household: listCredLaxmiCategories({ expenseType: 'HOUSEHOLD' }),
    business: listCredLaxmiCategories({ expenseType: 'BUSINESS' }),
    special: listCredLaxmiCategories({ expenseType: 'SPECIAL' }),
  });
});

creditCardSavingsRouter.post('/recommendation', async (req, res, next) => {
  try {
    const input = RecommendSchema.parse(req.body);
    const defaultPeriod = input.spendPeriod || 'monthly';
    const spends = input.spends.map((s) => ({
      categoryCode: s.categoryCode || s.category_code,
      amount: s.amount ?? s.spend ?? 0,
      period: s.period || s.frequency || defaultPeriod,
    }));

    const result = rankCredLaxmiCards(input.cards, spends);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
