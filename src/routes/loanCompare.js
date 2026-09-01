import { Router } from 'express';
import { z } from 'zod';

import { rankSmartLoanProducts, SMART_LOAN_PRIORITIES } from '../lib/smartLoanCalculator.js';

export const loanCompareRouter = Router();

const ProductSchema = z.object({
  id: z.string().optional(),
  productId: z.string().optional(),
  compareKey: z.string().optional(),
  name: z.string().optional(),
  productName: z.string().optional(),
  bankName: z.string().optional(),
  interestRate: z.coerce.number().optional(),
  interestRateMin: z.coerce.number().optional(),
  interestRateMax: z.coerce.number().optional(),
  interest_rate_min: z.coerce.number().optional(),
  interest_rate_max: z.coerce.number().optional(),
  processingFeePercentage: z.coerce.number().optional(),
  processing_fee_percentage: z.coerce.number().optional(),
  processingFeeFixed: z.coerce.number().optional(),
  processing_fee_fixed: z.coerce.number().optional(),
  foreclosureFeePct: z.coerce.number().optional(),
  foreclosure_fee_pct: z.coerce.number().optional(),
  foreclosureAllowedAfterMonths: z.coerce.number().optional(),
  foreclosure_allowed_after_months: z.coerce.number().optional(),
  partPaymentFeePct: z.coerce.number().optional(),
  part_payment_fee_pct: z.coerce.number().optional(),
  bouncingCharges: z.coerce.number().optional(),
  bouncing_charges: z.coerce.number().optional(),
  lateFeePct: z.coerce.number().optional(),
  late_fee_pct: z.coerce.number().optional(),
  latePaymentFeeFixed: z.coerce.number().optional(),
  maxTenureYears: z.coerce.number().optional(),
  max_tenure_years: z.coerce.number().optional(),
}).passthrough();

const SmartRecommendSchema = z.object({
  loanAmount: z.coerce.number().positive().max(1e12),
  tenureMonths: z.coerce.number().int().positive().max(480),
  loanPurpose: z.string().optional(),
  plannedLoanType: z.string().optional(),
  priorities: z.array(z.string()).max(3).default([]),
  gstOnProcessingPct: z.coerce.number().min(0).max(40).optional(),
  products: z.array(ProductSchema).min(1).max(12),
});

loanCompareRouter.get('/smart-priorities', (_req, res) => {
  res.json({
    priorities: SMART_LOAN_PRIORITIES,
    maxSelections: 3,
    labels: {
      low_roi: 'Lowest ROI',
      low_emi: 'Lowest EMI',
      max_tenure: 'Maximum Tenure',
      low_foreclosure: 'Zero/Low Foreclosure Charges',
      low_part_payment: 'Zero/Low Part-Payment Charges',
      low_bounce: 'Lowest Bouncing Charges',
      low_late_fee: 'Lowest Late Fees',
    },
  });
});

loanCompareRouter.post('/smart-recommendation', async (req, res, next) => {
  try {
    const input = SmartRecommendSchema.parse(req.body);
    const priorities = input.priorities
      .map((p) => String(p).toLowerCase().replace(/-/g, '_'))
      .filter((p) => SMART_LOAN_PRIORITIES.includes(p))
      .slice(0, 3);

    const result = rankSmartLoanProducts(input.products, {
      ...input,
      priorities: priorities.length ? priorities : ['low_roi', 'low_emi'],
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});
