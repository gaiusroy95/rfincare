import express, { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { newId } from '../lib/ids.js';

export const insuranceWebhooksRouter = Router();

function safeEqual(a, b) {
  try {
    return crypto.timingSafeEqual(Buffer.from(String(a || '')), Buffer.from(String(b || '')));
  } catch {
    return false;
  }
}

function parseJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

insuranceWebhooksRouter.post(
  '/insurance-success',
  express.raw({ type: 'application/json' }),
  async (req, res, next) => {
    try {
      const signature = req.headers['x-insurer-signature'] || req.headers['x-webhook-signature'] || '';
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      const payload = parseJson(rawBody.toString('utf8')) || {};

      const proposalId = payload?.proposalId || payload?.proposal_id || payload?.proposalNumber || payload?.proposal_number;
      if (!proposalId) return res.status(400).json({ error: 'Missing proposalId' });

      const pool = getPool();
      const [[order]] = await pool.execute(
        `SELECT o.*, pc.webhook_secret
         FROM insurance_purchase_orders o
         LEFT JOIN insurance_provider_configs pc ON pc.provider_code = o.insurer_provider_code
         WHERE o.proposal_id = :proposal_id OR o.proposal_number = :proposal_id
         ORDER BY o.created_at DESC
         LIMIT 1`,
        { proposal_id: String(proposalId) },
      );
      if (!order) return res.status(404).json({ error: 'Purchase order not found for proposalId' });

      const secret = String(order.webhook_secret || '').trim();
      if (secret) {
        const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
        if (!safeEqual(digest, signature)) {
          return res.status(401).json({ error: 'Invalid webhook signature' });
        }
      }

      const status = String(payload?.status || payload?.paymentStatus || payload?.payment_status || 'success').toLowerCase();
      const policyNumber = payload?.policyNumber || payload?.policy_number || null;
      const policyPdfUrl = payload?.policyPdfUrl || payload?.policy_pdf_url || payload?.policyUrl || payload?.policy_url || null;

      await pool.execute(
        `UPDATE insurance_purchase_orders
         SET payment_status = CASE WHEN :paid THEN 'paid' ELSE payment_status END,
             insurer_push_status = CASE WHEN :issued THEN 'pushed' ELSE insurer_push_status END,
             insurer_policy_number = COALESCE(:policy_number, insurer_policy_number),
             policy_pdf_url = COALESCE(:pdf_url, policy_pdf_url),
             paid_at = CASE WHEN :paid THEN COALESCE(paid_at, CURRENT_TIMESTAMP) ELSE paid_at END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = :id`,
        {
          id: order.id,
          paid: status === 'success' || status === 'paid' || status === 'captured',
          issued: Boolean(policyNumber || policyPdfUrl),
          policy_number: policyNumber,
          pdf_url: policyPdfUrl,
        },
      );

      await pool.execute(
        `INSERT INTO insurance_purchase_events (
           id, purchase_order_id, event_type, event_status, actor_type, request_payload, response_payload, message
         ) VALUES (
           :id, :order_id, 'insurer_webhook', 'info', 'insurer', :req::jsonb, NULL, :msg
         )`,
        {
          id: newId(),
          order_id: order.id,
          req: JSON.stringify(payload),
          msg: `Insurer webhook received: ${status}`,
        },
      );

      res.json({ received: true });
    } catch (err) {
      next(err);
    }
  },
);

