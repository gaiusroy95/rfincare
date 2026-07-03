import { Router } from 'express';
import { z } from 'zod';

import {
  confirmMutualFundSipMandate,
  createMutualFundSipOrder,
  getMutualFundSipOrder,
  updateMutualFundSipStatus,
} from '../lib/mutualFundSipService.js';
import { authenticate } from '../middleware/authenticate.js';

export const mutualFundSipsRouter = Router();

async function handleStatusUpdate(req, res, next) {
  try {
    const body = z.object({
      status: z.enum(['created', 'mandate_pending', 'active', 'failed', 'cancelled']),
      externalReference: z.string().optional().nullable(),
      token: z.string().optional(),
    }).parse(req.body);

    const row = await updateMutualFundSipStatus(req.params.id, {
      status: body.status,
      externalReference: body.externalReference,
      publicToken: body.token || req.query.token || null,
    });
    res.json(row);
  } catch (err) {
    next(err);
  }
}

mutualFundSipsRouter.post('/checkout', async (req, res, next) => {
  try {
    const data = await createMutualFundSipOrder(req.body || {});
    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

mutualFundSipsRouter.get('/:id', async (req, res, next) => {
  try {
    const token = z.string().min(8).parse(req.query.token);
    const row = await getMutualFundSipOrder(req.params.id, token);
    if (!row) return res.status(404).json({ error: 'SIP order not found' });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

mutualFundSipsRouter.post('/:id/confirm-mandate', async (req, res, next) => {
  try {
    const token = z.string().min(8).parse(req.query.token);
    const row = await confirmMutualFundSipMandate(req.params.id, token);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

mutualFundSipsRouter.patch('/:id/status', (req, res, next) => {
  const webhookSecret = process.env.MF_SIP_WEBHOOK_SECRET;
  const headerSecret = req.get('X-Mf-Sip-Webhook-Secret');
  const isWebhook = Boolean(webhookSecret && headerSecret === webhookSecret);

  if (isWebhook) {
    return handleStatusUpdate(req, res, next);
  }

  return authenticate(req, res, (err) => {
    if (err) return next(err);
    if (!['admin', 'super_admin', 'employee'].includes(req.auth?.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return handleStatusUpdate(req, res, next);
  });
});
