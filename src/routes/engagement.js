import { Router } from 'express';

import { getPool } from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { runEngagementNotificationBatch } from '../lib/customerEngagement.js';

export const engagementRouter = Router();

engagementRouter.post(
  '/run-notifications',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      const pool = getPool();
      const limit = Math.min(200, Math.max(1, parseInt(req.body?.limit, 10) || 50));
      const result = await runEngagementNotificationBatch(pool, { limit });
      res.json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  },
);

engagementRouter.get('/cron/run', async (req, res, next) => {
  try {
    const secret = process.env.ENGAGEMENT_CRON_SECRET;
    const header = req.get('X-Engagement-Cron-Secret') || req.query.secret;
    if (!secret || header !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const pool = getPool();
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const result = await runEngagementNotificationBatch(pool, { limit });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});
