import crypto from 'node:crypto';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { newId } from './ids.js';
import { normalizeAgentCode, resolveAgentByCode } from './agentAttribution.js';
import { recordAgentCommission } from './agentCommissionLedger.js';
import { upsertMarketingLead } from './marketingLeads.js';

const SipCheckoutSchema = z.object({
  fundId: z.string().min(1),
  sipAmount: z.coerce.number().positive(),
  sipDay: z.coerce.number().int().min(1).max(28).optional().default(1),
  tenureYears: z.coerce.number().int().min(1).max(40).optional().nullable(),
  customer: z.object({
    fullName: z.string().min(2),
    email: z.string().email(),
    phone: z.string().min(10),
  }),
  demographicData: z.record(z.unknown()).optional(),
  sourceProfile: z.record(z.unknown()).optional(),
  sourcedAgentCode: z.string().optional().nullable(),
  agentCode: z.string().optional().nullable(),
});

function createPublicToken() {
  return crypto.randomBytes(24).toString('hex');
}

export async function createMutualFundSipOrder(rawInput) {
  const input = SipCheckoutSchema.parse(rawInput);
  const pool = getPool();

  const [[fund]] = await pool.execute(
    `SELECT * FROM mutual_funds WHERE id = :id AND status = 'active' LIMIT 1`,
    { id: input.fundId },
  );
  if (!fund) {
    const err = new Error('Mutual fund not found');
    err.status = 404;
    throw err;
  }

  const agentCode = normalizeAgentCode(input.sourcedAgentCode || input.agentCode);
  let agent = null;
  if (agentCode) {
    agent = await resolveAgentByCode(pool, agentCode);
  }

  const { row: lead } = await upsertMarketingLead(pool, {
    fullName: input.customer.fullName,
    email: input.customer.email,
    phone: input.customer.phone,
    loanType: 'mutual_funds',
    source: 'mutual_funds_sip',
    consentAccepted: true,
    status: 'profile_complete',
  });

  if (agentCode && lead?.id) {
    try {
      await pool.execute(
        `UPDATE marketing_leads SET sourced_agent_code = :code WHERE id = :id`,
        { code: agent?.agentCode || agentCode, id: lead.id },
      );
    } catch {
      /* column may not exist until migration */
    }
  }

  const orderId = newId();
  const publicToken = createPublicToken();
  const investUrl = fund.invest_url || fund.investUrl || null;
  const demographicData = {
    ...(input.demographicData || {}),
    ...(input.sourceProfile || {}),
    fundName: fund.name,
    amcName: fund.amc_name,
    sipAmount: input.sipAmount,
    sipDay: input.sipDay,
    tenureYears: input.tenureYears,
    marketplaceType: 'mutual_funds',
  };

  await pool.execute(
    `INSERT INTO mutual_fund_sip_orders (
       id, public_token, mutual_fund_id, marketing_lead_id,
       customer_name, customer_email, customer_phone,
       sip_amount, sip_day, tenure_years, sourced_agent_code,
       status, invest_url, demographic_data
     ) VALUES (
       :id, :token, :fund_id, :lead_id,
       :name, :email, :phone,
       :amount, :day, :years, :agent_code,
       'created', :invest_url, :demo::jsonb
     )`,
    {
      id: orderId,
      token: publicToken,
      fund_id: fund.id,
      lead_id: lead?.id || null,
      name: input.customer.fullName,
      email: input.customer.email.toLowerCase(),
      phone: input.customer.phone,
      amount: input.sipAmount,
      day: input.sipDay,
      years: input.tenureYears || null,
      agent_code: agent?.agentCode || agentCode || null,
      invest_url: investUrl,
      demo: JSON.stringify(demographicData),
    },
  );

  return {
    orderId,
    publicToken,
    status: 'created',
    investUrl,
    fund: {
      id: fund.id,
      name: fund.name,
      amcName: fund.amc_name,
      minSipAmount: fund.min_sip_amount,
    },
    sipAmount: input.sipAmount,
    sipDay: input.sipDay,
    agentCode: agent?.agentCode || agentCode || null,
    leadId: lead?.id || null,
  };
}

const VALID_SIP_STATUSES = ['created', 'mandate_pending', 'active', 'failed', 'cancelled'];

export async function updateMutualFundSipStatus(orderId, { status, externalReference, publicToken } = {}) {
  if (!VALID_SIP_STATUSES.includes(status)) {
    const err = new Error(`Invalid SIP status: ${status}`);
    err.status = 400;
    throw err;
  }
  const pool = getPool();
  const params = { id: orderId, status, ref: externalReference || null };
  let where = 'WHERE id = :id';
  if (publicToken) {
    where += ' AND public_token = :token';
    params.token = publicToken;
  }
  const [[existing]] = await pool.execute(
    `SELECT * FROM mutual_fund_sip_orders ${where} LIMIT 1`,
    params,
  );
  if (!existing) {
    const err = new Error('SIP order not found');
    err.status = 404;
    throw err;
  }
  const previousStatus = existing.status;
  await pool.execute(
    `UPDATE mutual_fund_sip_orders
     SET status = :status,
         external_reference = COALESCE(:ref, external_reference),
         status_updated_at = NOW(),
         updated_at = NOW()
     WHERE id = :id`,
    { id: orderId, status, ref: externalReference || null },
  );

  if (status === 'active' && previousStatus !== 'active') {
    const sipAmount = Number(existing.sip_amount || 0);
    // Commission base = first-year SIP volume (monthly amount × 12).
    const annualBase = sipAmount * 12;
    await recordAgentCommission(pool, {
      agentCode: existing.sourced_agent_code,
      sourceType: 'mf_sip',
      sourceId: existing.id,
      productType: 'mutual_fund_sip',
      baseAmount: annualBase,
      status: 'paid',
    });
  }

  return getMutualFundSipOrder(orderId, publicToken || existing.public_token);
}

export async function confirmMutualFundSipMandate(orderId, publicToken) {
  const order = await getMutualFundSipOrder(orderId, publicToken);
  if (!order) {
    const err = new Error('SIP order not found');
    err.status = 404;
    throw err;
  }
  if (order.status === 'active') return order;
  const nextStatus = order.status === 'created' ? 'mandate_pending' : order.status;
  if (nextStatus === order.status) return order;
  await updateMutualFundSipStatus(orderId, { status: nextStatus, publicToken });
  return getMutualFundSipOrder(orderId, publicToken);
}

export async function getMutualFundSipOrder(id, publicToken) {
  const pool = getPool();
  const [[row]] = await pool.execute(
    `SELECT o.*, mf.name AS fund_name, mf.amc_name
     FROM mutual_fund_sip_orders o
     JOIN mutual_funds mf ON mf.id = o.mutual_fund_id
     WHERE o.id = :id AND o.public_token = :token
     LIMIT 1`,
    { id, token: publicToken },
  );
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    sipAmount: Number(row.sip_amount),
    sipDay: row.sip_day,
    tenureYears: row.tenure_years,
    investUrl: row.invest_url,
    fundName: row.fund_name,
    amcName: row.amc_name,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    sourcedAgentCode: row.sourced_agent_code,
    createdAt: row.created_at,
  };
}
