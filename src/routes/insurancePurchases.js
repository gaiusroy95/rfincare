import { Router } from 'express';
import { z } from 'zod';

import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import {
  completeInsurancePurchasePush,
  createInsuranceCheckout,
  createInsuranceProposal,
  fetchInsuranceQuote,
  getInsurancePurchaseById,
} from '../lib/insurancePurchaseService.js';

export const insurancePurchasesRouter = Router();

insurancePurchasesRouter.post('/checkout', async (req, res, next) => {
  try {
    const data = await createInsuranceCheckout(req.body || {});
    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

insurancePurchasesRouter.post('/quote', async (req, res, next) => {
  try {
    const body = z.object({
      productId: z.string().min(1),
      customer: z.record(z.unknown()),
      demographics: z.record(z.unknown()).optional(),
      coverage: z.record(z.unknown()).optional(),
    }).parse(req.body || {});
    const quote = await fetchInsuranceQuote(body);
    res.json(quote);
  } catch (err) {
    next(err);
  }
});

insurancePurchasesRouter.post('/proposal', async (req, res, next) => {
  try {
    const body = z.object({
      purchaseOrderId: z.string().min(1),
      token: z.string().min(8),
      quoteId: z.string().optional().nullable(),
      returnUrl: z.string().url().optional().nullable(),
      customer: z.record(z.unknown()),
      demographics: z.record(z.unknown()).optional(),
    }).parse(req.body || {});
    const result = await createInsuranceProposal({
      purchaseOrderId: body.purchaseOrderId,
      publicToken: body.token,
      quoteId: body.quoteId || null,
      returnUrl: body.returnUrl || null,
      customer: body.customer,
      demographics: body.demographics || {},
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

insurancePurchasesRouter.get('/:id', async (req, res, next) => {
  try {
    const token = z.string().min(8).parse(req.query.token);
    const row = await getInsurancePurchaseById(req.params.id, token);
    if (!row) return res.status(404).json({ error: 'Purchase order not found' });
    res.json({
      id: row.id,
      customerName: row.customer_name,
      customerEmail: row.customer_email,
      customerPhone: row.customer_phone,
      productName: row.product_name,
      insurerName: row.insurer_name,
      paymentAmount: Number(row.payment_amount),
      paymentCurrency: row.payment_currency,
      paymentStatus: row.payment_status,
      insurerPushStatus: row.insurer_push_status,
      proposalNumber: row.proposal_number,
      paymentUrl: row.insurer_payment_url,
      paymentMode: row.insurer_payment_mode,
      policyPdfUrl: row.policy_pdf_url,
      insurerReferenceId: row.insurer_reference_id,
      insurerPolicyNumber: row.insurer_policy_number,
      failureReason: row.failure_reason,
      paidAt: row.paid_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  } catch (err) {
    next(err);
  }
});

insurancePurchasesRouter.post(
  '/:id/retry-push',
  authenticate,
  authorize({ resource: 'banks', action: 'update' }),
  async (req, res, next) => {
    try {
      await completeInsurancePurchasePush(req.params.id);
      const token = z.string().min(8).parse(req.body?.token || req.query?.token);
      const row = await getInsurancePurchaseById(req.params.id, token);
      res.json({
        success: true,
        paymentStatus: row?.payment_status || null,
        insurerPushStatus: row?.insurer_push_status || null,
      });
    } catch (err) {
      next(err);
    }
  },
);
