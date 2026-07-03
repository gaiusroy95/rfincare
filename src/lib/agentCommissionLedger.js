import { newId } from './ids.js';
import { normalizeAgentCode } from './agentAttribution.js';
import { resolveAgentCommissionConfig } from './agentCommission.js';
import { calculateCommissionFromAmount } from './agentCustomerProvision.js';

export async function findAgentUserIdByCode(pool, agentCode) {
  const code = normalizeAgentCode(agentCode);
  if (!code) return null;
  const [[row]] = await pool.execute(
    `SELECT ao.user_id
     FROM agent_onboarding ao
     INNER JOIN user_profiles up ON up.id = ao.user_id AND up.role = 'agent'
     WHERE ao.agent_code = :code
     LIMIT 1`,
    { code },
  );
  return row?.user_id || null;
}

/**
 * Idempotent commission accrual for marketplace orders.
 * SIP commission base = first year SIP (sip_amount * 12).
 */
export async function recordAgentCommission(
  pool,
  {
    agentUserId,
    agentCode,
    sourceType,
    sourceId,
    productType,
    baseAmount,
    status = 'pending',
  },
) {
  if (!sourceType || !sourceId || !productType) return null;

  let resolvedAgentUserId = agentUserId;
  if (!resolvedAgentUserId && agentCode) {
    resolvedAgentUserId = await findAgentUserIdByCode(pool, agentCode);
  }
  if (!resolvedAgentUserId) return null;

  const amount = Number(baseAmount);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const config = await resolveAgentCommissionConfig(pool, resolvedAgentUserId, productType);
  const commissionAmount = calculateCommissionFromAmount({ amount, config });
  if (!commissionAmount) return null;

  const [[existing]] = await pool.execute(
    `SELECT id FROM agent_commission_ledger
     WHERE source_type = :sourceType AND source_id = :sourceId
     LIMIT 1`,
    { sourceType, sourceId },
  );
  if (existing?.id) {
    const [[row]] = await pool.execute(
      `SELECT * FROM agent_commission_ledger WHERE id = :id`,
      { id: existing.id },
    );
    return row;
  }

  const id = newId();
  await pool.execute(
    `INSERT INTO agent_commission_ledger (
       id, agent_user_id, source_type, source_id, product_type,
       base_amount, commission_amount, status
     ) VALUES (
       :id, :agentUserId, :sourceType, :sourceId, :productType,
       :baseAmount, :commissionAmount, :status
     )`,
    {
      id,
      agentUserId: resolvedAgentUserId,
      sourceType,
      sourceId,
      productType,
      baseAmount: amount,
      commissionAmount,
      status,
    },
  );

  const [[row]] = await pool.execute(
    `SELECT * FROM agent_commission_ledger WHERE id = :id`,
    { id },
  );
  return row;
}

export async function fetchAgentCommissionLedger(pool, agentUserId, { limit = 50 } = {}) {
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM agent_commission_ledger
       WHERE agent_user_id = :uid
       ORDER BY created_at DESC
       LIMIT :limit`,
      { uid: agentUserId, limit },
    );
    return rows || [];
  } catch {
    return [];
  }
}

export function mapLedgerEntryToCommission(row, { insuranceOrders = [], sipOrders = [] } = {}) {
  let clientName = 'Customer';
  let label = row.product_type;

  if (row.source_type === 'insurance_purchase') {
    const order = insuranceOrders.find((o) => o.id === row.source_id);
    clientName = order?.customer_name || 'Insurance customer';
    label = 'Insurance';
  } else if (row.source_type === 'mf_sip') {
    const order = sipOrders.find((o) => o.id === row.source_id);
    clientName = order?.customer_name || 'SIP customer';
    label = 'MF SIP';
  }

  return {
    id: row.id,
    clientName,
    loanType: label,
    productType: row.product_type,
    sourceType: row.source_type,
    amount: Number(row.commission_amount),
    baseAmount: Number(row.base_amount),
    status: row.status === 'paid' ? 'paid' : 'processing',
    date: row.created_at,
  };
}
