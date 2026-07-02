import crypto from 'node:crypto';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { newId } from './ids.js';
import { pushPurchaseToInsurer, fetchQuoteFromProvider, createProposalWithProvider } from './insurerAdapters/index.js';

const CheckoutSchema = z.object({
  productId: z.string().min(1),
  selectedPremium: z.coerce.number().positive(),
  customer: z.object({
    fullName: z.string().min(2),
    email: z.string().email(),
    phone: z.string().min(10),
    dob: z.string().optional().nullable(),
    gender: z.string().optional().nullable(),
    pan: z.string().optional().nullable(),
    addressLine1: z.string().min(3),
    addressLine2: z.string().optional().nullable(),
    city: z.string().min(2),
    state: z.string().min(2),
    pincode: z.string().min(4),
    nomineeName: z.string().optional().nullable(),
    nomineeRelation: z.string().optional().nullable(),
  }),
  demographicData: z.record(z.unknown()).optional(),
  sourceProfile: z.record(z.unknown()).optional(),
});

function parseJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function createPublicToken() {
  return crypto.randomBytes(24).toString('hex');
}

function toPaise(amount) {
  return Math.round(Number(amount || 0) * 100);
}

function normalizeProduct(row) {
  return {
    ...row,
    purchase_enabled: row.purchase_enabled === true || row.purchase_enabled === 'true',
    demographic_mapping: parseJson(row.demographic_mapping, {}),
  };
}

export async function getProviderConfigByCode(pool, providerCode) {
  if (!providerCode) return null;
  const [[row]] = await pool.execute(
    `SELECT * FROM insurance_provider_configs
     WHERE provider_code = :code AND status = 'active'
     LIMIT 1`,
    { code: providerCode },
  );
  return row || null;
}

async function recordEvent(pool, orderId, {
  type,
  status = 'info',
  actorType = 'system',
  requestPayload = null,
  responsePayload = null,
  message = null,
}) {
  await pool.execute(
    `INSERT INTO insurance_purchase_events (
       id, purchase_order_id, event_type, event_status, actor_type,
       request_payload, response_payload, message
     ) VALUES (
       :id, :order_id, :event_type, :event_status, :actor_type,
       :request_payload::jsonb, :response_payload::jsonb, :message
     )`,
    {
      id: newId(),
      order_id: orderId,
      event_type: type,
      event_status: status,
      actor_type: actorType,
      request_payload: requestPayload ? JSON.stringify(requestPayload) : null,
      response_payload: responsePayload ? JSON.stringify(responsePayload) : null,
      message,
    },
  );
}

function buildInsurerPayload({ order, product, providerConfig }) {
  const demographicMapping = parseJson(product.demographic_mapping, {});
  return {
    order: {
      id: order.id,
      publicToken: order.public_token,
      paymentAmount: Number(order.payment_amount),
      currency: order.payment_currency,
      paymentProvider: order.payment_provider,
      paymentReference: order.razorpay_payment_id || null,
    },
    customer: {
      name: order.customer_name,
      email: order.customer_email,
      phone: order.customer_phone,
      ...parseJson(order.demographic_data, {}),
    },
    product: {
      id: product.id,
      insurerName: product.insurer_name,
      planName: product.name,
      segment: product.segment,
      insurerProviderCode: product.insurer_provider_code,
      insurerProductCode: product.insurer_product_code,
      insurerPlanCode: product.insurer_plan_code,
    },
    demographicMapping,
    providerCode: providerConfig?.provider_code || product.insurer_provider_code,
  };
}

export async function createInsuranceCheckout(rawInput) {
  const input = CheckoutSchema.parse(rawInput);
  const pool = getPool();

  const [[productRow]] = await pool.execute(
    `SELECT * FROM insurance_products WHERE id = :id LIMIT 1`,
    { id: input.productId },
  );
  if (!productRow) {
    const err = new Error('Insurance product not found');
    err.status = 404;
    throw err;
  }

  const product = normalizeProduct(productRow);
  if (!product.purchase_enabled) {
    const err = new Error('This insurance plan is not enabled for on-site purchase');
    err.status = 400;
    throw err;
  }

  const providerConfig = await getProviderConfigByCode(pool, product.insurer_provider_code);
  const pricingSnapshot = {
    premiumFrom: product.premium_from,
    premiumTo: product.premium_to,
    premiumUnit: product.premium_unit,
    selectedPremium: input.selectedPremium,
    currency: 'INR',
  };

  const orderId = newId();
  const publicToken = createPublicToken();
  const demographicData = {
    ...input.demographicData,
    ...input.sourceProfile,
    ...input.customer,
  };

  await pool.execute(
    `INSERT INTO insurance_purchase_orders (
       id, public_token, insurance_product_id, insurer_provider_code, insurer_product_code, insurer_plan_code,
       customer_name, customer_email, customer_phone, demographic_data, pricing_snapshot,
       payment_amount, payment_currency, payment_provider, payment_account_code,
       payment_status, purchase_mode, insurer_push_status, insurer_payment_mode
     ) VALUES (
       :id, :public_token, :insurance_product_id, :insurer_provider_code, :insurer_product_code, :insurer_plan_code,
       :customer_name, :customer_email, :customer_phone, :demographic_data::jsonb, :pricing_snapshot::jsonb,
       :payment_amount, :payment_currency, :payment_provider, :payment_account_code,
       'created', :purchase_mode, 'not_started', :insurer_payment_mode
     )`,
    {
      id: orderId,
      public_token: publicToken,
      insurance_product_id: product.id,
      insurer_provider_code: product.insurer_provider_code || null,
      insurer_product_code: product.insurer_product_code || null,
      insurer_plan_code: product.insurer_plan_code || null,
      customer_name: input.customer.fullName,
      customer_email: input.customer.email.toLowerCase(),
      customer_phone: input.customer.phone,
      demographic_data: JSON.stringify(demographicData),
      pricing_snapshot: JSON.stringify(pricingSnapshot),
      payment_amount: input.selectedPremium,
      payment_currency: 'INR',
      payment_provider: 'insurer_gateway',
      payment_account_code: product.payment_account_code || null,
      purchase_mode: product.purchase_mode || 'api',
      insurer_payment_mode: 'redirect',
    },
  );

  await recordEvent(pool, orderId, {
    type: 'checkout_created',
    status: 'info',
    actorType: 'customer',
    requestPayload: { input: rawInput },
    message: 'Checkout created (awaiting quote/proposal/payment)',
  });

  return {
    orderId,
    publicToken,
    paymentStatus: 'created',
    insurerPushStatus: 'not_started',
    product: {
      id: product.id,
      name: product.name,
      insurerName: product.insurer_name,
    },
    providerCode: providerConfig?.provider_code || product.insurer_provider_code || null,
  };
}

export async function fetchInsuranceQuote({ productId, customer, demographics, coverage }) {
  const pool = getPool();
  const [[productRow]] = await pool.execute(`SELECT * FROM insurance_products WHERE id = :id LIMIT 1`, { id: productId });
  if (!productRow) {
    const err = new Error('Insurance product not found');
    err.status = 404;
    throw err;
  }
  const product = normalizeProduct(productRow);
  if (!product.purchase_enabled) {
    const err = new Error('This plan is not enabled for on-site purchase');
    err.status = 400;
    throw err;
  }
  const providerConfig = await getProviderConfigByCode(pool, product.insurer_provider_code);
  if (!providerConfig) {
    const err = new Error('Insurer provider config is missing');
    err.status = 400;
    throw err;
  }
  const payload = { customer, demographics, coverage, product: { insurerProductCode: product.insurer_product_code, insurerPlanCode: product.insurer_plan_code } };
  const res = await fetchQuoteFromProvider({ providerConfig, payload });
  return res;
}

export async function createInsuranceProposal({ purchaseOrderId, publicToken, customer, demographics, quoteId, returnUrl }) {
  const pool = getPool();
  const [[order]] = await pool.execute(
    `SELECT * FROM insurance_purchase_orders WHERE id = :id AND public_token = :t LIMIT 1`,
    { id: purchaseOrderId, t: publicToken },
  );
  if (!order) {
    const err = new Error('Purchase order not found');
    err.status = 404;
    throw err;
  }
  const [[product]] = await pool.execute(`SELECT * FROM insurance_products WHERE id = :id LIMIT 1`, { id: order.insurance_product_id });
  const providerConfig = await getProviderConfigByCode(pool, order.insurer_provider_code);
  if (!providerConfig) {
    const err = new Error('Insurer provider config is missing');
    err.status = 400;
    throw err;
  }

  const payload = {
    quoteId,
    customer,
    demographics,
    returnUrl,
    product: {
      insurerProductCode: order.insurer_product_code,
      insurerPlanCode: order.insurer_plan_code,
    },
  };

  const result = await createProposalWithProvider({ providerConfig, payload });
  const paymentUrl = result.paymentUrl || result.payment_link || null;
  const paymentMode = result.paymentMode || result.payment_mode || 'redirect';
  const proposalId = result.proposalId || result.proposal_id || null;
  const proposalNumber = result.proposalNumber || result.proposal_number || null;

  await pool.execute(
    `UPDATE insurance_purchase_orders
     SET quote_id = COALESCE(:quote_id, quote_id),
         proposal_id = :proposal_id,
         proposal_number = :proposal_number,
         insurer_payment_url = :payment_url,
         insurer_payment_mode = :payment_mode,
         payment_status = 'pending_payment',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = :id`,
    {
      id: order.id,
      quote_id: quoteId || null,
      proposal_id: proposalId,
      proposal_number: proposalNumber,
      payment_url: paymentUrl,
      payment_mode: paymentMode,
    },
  );

  await recordEvent(pool, order.id, {
    type: 'proposal_created',
    status: 'info',
    actorType: 'customer',
    requestPayload: payload,
    responsePayload: result,
    message: 'Proposal created with insurer/aggregator',
  });

  return { proposalId, proposalNumber, paymentUrl, paymentMode };
}

export async function getInsurancePurchaseById(id, publicToken) {
  const pool = getPool();
  const [[row]] = await pool.execute(
    `SELECT o.*, p.name AS product_name, p.insurer_name
     FROM insurance_purchase_orders o
     JOIN insurance_products p ON p.id = o.insurance_product_id
     WHERE o.id = :id AND o.public_token = :token
     LIMIT 1`,
    { id, token: publicToken },
  );
  return row || null;
}

export async function completeInsurancePurchasePush(orderId) {
  const pool = getPool();
  const [[order]] = await pool.execute(
    `SELECT * FROM insurance_purchase_orders WHERE id = :id LIMIT 1`,
    { id: orderId },
  );
  if (!order) {
    const err = new Error('Purchase order not found');
    err.status = 404;
    throw err;
  }
  if (order.insurer_push_status === 'pushed') return order;

  const [[product]] = await pool.execute(
    `SELECT * FROM insurance_products WHERE id = :id LIMIT 1`,
    { id: order.insurance_product_id },
  );
  if (!product) {
    const err = new Error('Insurance product not found for purchase order');
    err.status = 404;
    throw err;
  }

  const providerConfig = await getProviderConfigByCode(pool, order.insurer_provider_code);
  if (!providerConfig && order.purchase_mode === 'api') {
    await pool.execute(
      `UPDATE insurance_purchase_orders
       SET insurer_push_status = 'push_failed',
           failure_reason = :reason,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = :id`,
      { id: orderId, reason: 'Missing insurer provider configuration' },
    );
    await recordEvent(pool, orderId, {
      type: 'insurer_push_failed',
      status: 'error',
      message: 'Missing insurer provider configuration',
    });
    return;
  }

  const payload = buildInsurerPayload({ order, product, providerConfig });
  await pool.execute(
    `UPDATE insurance_purchase_orders
     SET insurer_push_status = 'push_pending', updated_at = CURRENT_TIMESTAMP
     WHERE id = :id`,
    { id: orderId },
  );

  try {
    const result = await pushPurchaseToInsurer({
      providerConfig,
      purchaseOrder: order,
      payload,
    });
    await pool.execute(
      `UPDATE insurance_purchase_orders
       SET insurer_push_status = 'pushed',
           insurer_reference_id = :ref,
           insurer_policy_number = :policy,
           insurer_response_summary = :summary,
           failure_reason = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = :id`,
      {
        id: orderId,
        ref: result.externalReferenceId || null,
        policy: result.policyNumber || null,
        summary: result.summary || null,
      },
    );
    await recordEvent(pool, orderId, {
      type: 'insurer_push_success',
      status: 'success',
      requestPayload: payload,
      responsePayload: result.response || result,
      message: result.summary || 'Insurer accepted purchase',
    });
  } catch (err) {
    await pool.execute(
      `UPDATE insurance_purchase_orders
       SET insurer_push_status = 'push_failed',
           failure_reason = :reason,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = :id`,
      { id: orderId, reason: err?.message || 'Insurer push failed' },
    );
    await recordEvent(pool, orderId, {
      type: 'insurer_push_failed',
      status: 'error',
      requestPayload: payload,
      responsePayload: err?.response?.data || null,
      message: err?.message || 'Insurer push failed',
    });
    throw err;
  }
}

export async function markInsuranceOrderPaid({
  razorpayOrderId,
  razorpayPaymentId,
  razorpaySignature,
  eventPayload = null,
}) {
  const pool = getPool();
  const [[order]] = await pool.execute(
    `SELECT * FROM insurance_purchase_orders WHERE razorpay_order_id = :order_id LIMIT 1`,
    { order_id: razorpayOrderId },
  );
  if (!order) return null;
  if (order.payment_status === 'paid') return order;

  await pool.execute(
    `UPDATE insurance_purchase_orders
     SET payment_status = 'paid',
         razorpay_payment_id = COALESCE(:payment_id, razorpay_payment_id),
         razorpay_signature = COALESCE(:signature, razorpay_signature),
         paid_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = :id`,
    {
      id: order.id,
      payment_id: razorpayPaymentId || null,
      signature: razorpaySignature || null,
    },
  );

  await recordEvent(pool, order.id, {
    type: 'payment_confirmed',
    status: 'success',
    requestPayload: eventPayload,
    responsePayload: {
      razorpayOrderId,
      razorpayPaymentId,
    },
    message: 'Razorpay payment confirmed',
  });

  return order;
}
