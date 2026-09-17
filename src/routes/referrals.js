import { Router } from 'express';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';
import {
  buildReferralShareLinks,
  countAttributedReferrals,
  createReferralInvite,
  ensureReferralCodeForUser,
  ensureReferralSchema,
  listReferralInvites,
  normalizeReferralProgram,
} from '../lib/referralTracking.js';
import {
  ensureReferralEngineSchema,
  getReferrerPerformanceMetrics,
  getReferralSettings,
  recordReferralClick,
  createInviteLeadAttribution,
} from '../lib/referralEngine.js';

export const referralsRouter = Router();

referralsRouter.get('/settings/public', async (_req, res, next) => {
  try {
    const pool = getPool();
    const settings = await getReferralSettings(pool);
    res.json({
      attributionWindowDays: settings.attributionWindowDays,
    });
  } catch (err) {
    next(err);
  }
});

referralsRouter.post('/click', async (req, res, next) => {
  try {
    const input = z
      .object({
        code: z.string().trim().min(3).max(64),
        program: z.enum(['agent', 'customer']).optional(),
        landingUrl: z.string().trim().max(2000).optional().or(z.literal('')),
        sourceUrl: z.string().trim().max(2000).optional().or(z.literal('')),
        utmSource: z.string().trim().max(128).optional().or(z.literal('')),
        utmMedium: z.string().trim().max(128).optional().or(z.literal('')),
        utmCampaign: z.string().trim().max(128).optional().or(z.literal('')),
        deviceRef: z.string().trim().max(255).optional().or(z.literal('')),
        sessionToken: z.string().trim().max(64).optional().or(z.literal('')),
      })
      .parse(req.body || {});

    const pool = getPool();
    const ip =
      req.headers['x-forwarded-for']?.toString()?.split(',')?.[0]?.trim()
      || req.socket?.remoteAddress
      || null;

    const result = await recordReferralClick(pool, {
      code: input.code,
      program: input.program,
      landingUrl: input.landingUrl || null,
      sourceUrl: input.sourceUrl || null,
      utmSource: input.utmSource || null,
      utmMedium: input.utmMedium || null,
      utmCampaign: input.utmCampaign || null,
      deviceRef: input.deviceRef || null,
      sessionToken: input.sessionToken || null,
      ip,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

referralsRouter.get('/', authenticate, async (req, res, next) => {
  try {
    const program = normalizeReferralProgram(req.query.program) || 'customer';
    const pool = getPool();
    await ensureReferralSchema(pool);
    await ensureReferralEngineSchema(pool);
    const code = await ensureReferralCodeForUser(pool, {
      userId: req.auth.userId,
      role: req.auth.role,
      program,
    });
    const attributedCount = await countAttributedReferrals(pool, {
      referrerUserId: req.auth.userId,
      program,
    });
    const invites = await listReferralInvites(pool, {
      referrerUserId: req.auth.userId,
      program,
    });
    const metrics = await getReferrerPerformanceMetrics(pool, req.auth.userId, program);
    res.json({
      program,
      referralCode: code?.code || null,
      shareLinks: code?.code ? buildReferralShareLinks(code.code, program) : null,
      attributedCount,
      invites,
      metrics,
    });
  } catch (err) {
    next(err);
  }
});

referralsRouter.post('/invites', authenticate, async (req, res, next) => {
  try {
    const input = z
      .object({
        program: z.enum(['agent', 'customer']).default('customer'),
        name: z.string().trim().min(1).max(255),
        email: z.string().trim().email().optional().or(z.literal('')),
        phone: z.string().trim().optional().or(z.literal('')),
        channel: z.string().trim().max(32).optional(),
      })
      .parse(req.body || {});

    const pool = getPool();
    const invite = await createReferralInvite(pool, {
      referrerUserId: req.auth.userId,
      referrerRole: req.auth.role,
      program: input.program,
      referredName: input.name,
      referredEmail: input.email || null,
      referredPhone: String(input.phone || '').replace(/\D/g, '').slice(-10) || null,
      channel: input.channel || 'share',
    });
    try {
      await createInviteLeadAttribution(pool, {
        referrerUserId: req.auth.userId,
        referrerCode: invite.referralCode,
        program: invite.program || input.program,
        referredName: input.name,
        referredEmail: input.email || null,
        referredPhone: String(input.phone || '').replace(/\D/g, '').slice(-10) || null,
        channel: input.channel || 'share',
      });
    } catch {
      /* attribution is best-effort; invite row is the source of truth for share actions */
    }
    const metrics = await getReferrerPerformanceMetrics(
      pool,
      req.auth.userId,
      invite.program || input.program,
    );
    res.status(201).json({ ...invite, metrics });
  } catch (err) {
    next(err);
  }
});
