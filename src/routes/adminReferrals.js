import { Router } from 'express';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';
import {
  ensureReferralEngineSchema,
  getAdminReferralDashboard,
  getReferralSettings,
  listCommissionRules,
  listReferralAttributions,
  listReferralTransactions,
  listRewardRules,
  overrideAttributionFraud,
  updateReferralSettings,
  updateReferralTransactionStatus,
  upsertCommissionRule,
  upsertRewardRule,
} from '../lib/referralEngine.js';

export const adminReferralsRouter = Router();

function requireAdmin(req) {
  if (!['admin', 'super_admin'].includes(req.auth?.role)) {
    const e = new Error('Admin access required');
    e.status = 403;
    throw e;
  }
}

adminReferralsRouter.use(authenticate);
adminReferralsRouter.use((req, _res, next) => {
  try {
    requireAdmin(req);
    next();
  } catch (err) {
    next(err);
  }
});

adminReferralsRouter.get('/dashboard', async (_req, res, next) => {
  try {
    const pool = getPool();
    const data = await getAdminReferralDashboard(pool);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

adminReferralsRouter.get('/settings', async (_req, res, next) => {
  try {
    const pool = getPool();
    res.json(await getReferralSettings(pool));
  } catch (err) {
    next(err);
  }
});

adminReferralsRouter.put('/settings', async (req, res, next) => {
  try {
    const input = z
      .object({
        attributionWindowDays: z.number().int().optional(),
        firstTouchPolicy: z.string().optional(),
        existingCustomerPolicy: z.string().optional(),
        customerRewardType: z.string().optional(),
        customerRewardAmount: z.number().optional(),
        customerRewardMinDisbursement: z.number().optional(),
        customerRewardTrigger: z.string().optional(),
        customerRewardMaxPerMonth: z.number().int().optional(),
        agentCommissionTdsRate: z.number().optional(),
      })
      .parse(req.body || {});
    const pool = getPool();
    res.json(await updateReferralSettings(pool, input));
  } catch (err) {
    next(err);
  }
});

adminReferralsRouter.get('/attributions', async (req, res, next) => {
  try {
    const pool = getPool();
    const rows = await listReferralAttributions(pool, {
      referralType: req.query.type || undefined,
      status: req.query.status || undefined,
      fraudOnly: req.query.fraud === '1' || req.query.fraud === 'true',
      limit: req.query.limit,
    });
    res.json({ attributions: rows });
  } catch (err) {
    next(err);
  }
});

adminReferralsRouter.get('/transactions', async (req, res, next) => {
  try {
    const pool = getPool();
    const rows = await listReferralTransactions(pool, {
      paymentStatus: req.query.paymentStatus || undefined,
      referralType: req.query.type || undefined,
      from: req.query.from || undefined,
      to: req.query.to || undefined,
      limit: req.query.limit,
    });
    res.json({ transactions: rows });
  } catch (err) {
    next(err);
  }
});

adminReferralsRouter.get('/transactions/export', async (req, res, next) => {
  try {
    const pool = getPool();
    const rows = await listReferralTransactions(pool, {
      paymentStatus: req.query.paymentStatus || undefined,
      referralType: req.query.type || undefined,
      from: req.query.from || undefined,
      to: req.query.to || undefined,
      limit: 5000,
    });
    const header = [
      'public_id',
      'referral_type',
      'referrer_name',
      'application_number',
      'product',
      'lender',
      'disbursed_amount',
      'commission_amount',
      'reward_amount',
      'tds_amount',
      'net_amount',
      'payment_status',
      'eligibility_status',
      'created_at',
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.public_id,
          r.referral_type,
          `"${String(r.referrer_name || '').replace(/"/g, '""')}"`,
          r.application_number || '',
          r.product || '',
          `"${String(r.lender || '').replace(/"/g, '""')}"`,
          r.disbursed_amount,
          r.commission_amount,
          r.reward_amount,
          r.tds_amount,
          r.net_amount,
          r.payment_status,
          r.eligibility_status,
          r.created_at,
        ].join(','),
      );
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="referral-transactions-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

adminReferralsRouter.patch('/transactions/:id/status', async (req, res, next) => {
  try {
    const input = z
      .object({
        paymentStatus: z.enum([
          'pending_verification',
          'verified',
          'approved',
          'payable',
          'paid',
          'rejected',
          'ineligible',
        ]),
        notes: z.string().max(2000).optional(),
      })
      .parse(req.body || {});
    const pool = getPool();
    const row = await updateReferralTransactionStatus(pool, req.params.id, input.paymentStatus, {
      notes: input.notes,
      actorId: req.auth.userId,
    });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

adminReferralsRouter.post('/attributions/:id/fraud-override', async (req, res, next) => {
  try {
    const input = z
      .object({
        clear: z.boolean().default(true),
        notes: z.string().max(2000).optional(),
      })
      .parse(req.body || {});
    const pool = getPool();
    const row = await overrideAttributionFraud(pool, req.params.id, {
      clear: input.clear,
      notes: input.notes,
      actorId: req.auth.userId,
    });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

adminReferralsRouter.get('/rules/commission', async (_req, res, next) => {
  try {
    res.json({ rules: await listCommissionRules(getPool()) });
  } catch (err) {
    next(err);
  }
});

adminReferralsRouter.post('/rules/commission', async (req, res, next) => {
  try {
    const pool = getPool();
    await ensureReferralEngineSchema(pool);
    const row = await upsertCommissionRule(pool, req.body || {});
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

adminReferralsRouter.put('/rules/commission/:id', async (req, res, next) => {
  try {
    const row = await upsertCommissionRule(getPool(), { ...(req.body || {}), id: req.params.id });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

adminReferralsRouter.get('/rules/reward', async (_req, res, next) => {
  try {
    res.json({ rules: await listRewardRules(getPool()) });
  } catch (err) {
    next(err);
  }
});

adminReferralsRouter.post('/rules/reward', async (req, res, next) => {
  try {
    const row = await upsertRewardRule(getPool(), req.body || {});
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

adminReferralsRouter.put('/rules/reward/:id', async (req, res, next) => {
  try {
    const row = await upsertRewardRule(getPool(), { ...(req.body || {}), id: req.params.id });
    res.json(row);
  } catch (err) {
    next(err);
  }
});
