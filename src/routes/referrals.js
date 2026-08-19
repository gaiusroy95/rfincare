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

export const referralsRouter = Router();

referralsRouter.get('/', authenticate, async (req, res, next) => {
  try {
    const program = normalizeReferralProgram(req.query.program) || 'customer';
    const pool = getPool();
    await ensureReferralSchema(pool);
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
    res.json({
      program,
      referralCode: code?.code || null,
      shareLinks: code?.code ? buildReferralShareLinks(code.code, program) : null,
      attributedCount,
      invites,
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
    res.status(201).json(invite);
  } catch (err) {
    next(err);
  }
});
