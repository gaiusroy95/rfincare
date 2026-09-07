import * as XLSX from 'xlsx';

import { getPool } from '../db/pool.js';
import { buildSimpleTextPdf } from './simplePdf.js';
import { ensureMilestone4Schema } from '../db/ensureMilestone4Schema.js';

const TDS_RATE = 0.1;

function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function mapCommissionStatus(appStatus, row) {
  if (row.commission_status) return row.commission_status;
  const s = String(appStatus || '').toLowerCase();
  if (s === 'disbursed') return 'paid';
  if (['approved'].includes(s)) return 'in_process';
  if (['rejected', 'draft'].includes(s)) return 'ineligible';
  if (['submitted', 'under_review', 'documents_pending'].includes(s)) return 'pending';
  return 'pending';
}

function resolveCommissionRate(config, loanType) {
  const rate = Number(config?.commission_value ?? 2.5);
  return config?.commission_type === 'fixed' ? null : rate;
}

function computeRowCommission(row, config) {
  const data = parseJson(row.data);
  const disbursed = Number(row.disbursed_amount || 0);
  const requested = Number(
    data.requested_loan_amount || data.loan_amount || data.requestedLoanAmount || 0,
  );
  const base = disbursed > 0 ? disbursed : requested;
  const rate = row.commission_rate != null ? Number(row.commission_rate) : resolveCommissionRate(config, row.loan_type);
  if (!base || base <= 0) return { gross: 0, rate: rate || 0, tds: 0, net: 0 };
  const gross =
    row.commission_amount != null
      ? Number(row.commission_amount)
      : rate
        ? Math.round((base * rate) / 100)
        : 0;
  const tds = row.tds_amount != null ? Number(row.tds_amount) : Math.round(gross * TDS_RATE);
  const net = row.net_payout != null ? Number(row.net_payout) : gross - tds;
  return { gross, rate: rate || 0, tds, net, base };
}

export async function buildAgentCommissionReport(agentId, filters = {}) {
  await ensureMilestone4Schema();
  const pool = getPool();
  const { resolveAgentCommissionConfig } = await import('./agentCommission.js');
  const config = await resolveAgentCommissionConfig(pool, agentId);

  const conditions = ['la.agent_id = :agentId'];
  const params = { agentId };

  if (filters.from) {
    conditions.push('la.created_at >= :from');
    params.from = filters.from;
  }
  if (filters.to) {
    conditions.push('la.created_at <= :to');
    params.to = `${filters.to} 23:59:59`;
  }
  if (filters.applicationStatus && filters.applicationStatus !== 'all') {
    conditions.push('la.status = :appStatus');
    params.appStatus = filters.applicationStatus;
  }
  if (filters.commissionStatus && filters.commissionStatus !== 'all') {
    conditions.push('COALESCE(la.commission_status, :fallback) = :commStatus');
    params.commStatus = filters.commissionStatus;
    params.fallback = filters.commissionStatus;
  }
  if (filters.loanType && filters.loanType !== 'all') {
    conditions.push(
      `la.data->>'loan_type' = :loanType OR la.data->>'loan_purpose' = :loanType`,
    );
    params.loanType = filters.loanType;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [rows] = await pool.execute(
    `SELECT la.*, c.full_name AS customer_name, ao.agent_code, ao.agent_name
     FROM loan_applications la
     JOIN user_profiles c ON c.id = la.customer_id
     LEFT JOIN agent_onboarding ao ON ao.user_id = la.agent_id
     ${where}
     ORDER BY la.created_at DESC`,
    params,
  );

  const generatedAt = new Date().toISOString();
  const appEntries = rows.map((row) => {
    const data = parseJson(row.data);
    const loanType = data.loan_type || data.loan_purpose || row.loan_type;
    const comm = computeRowCommission(row, config);
    return {
      source: 'loan_application',
      applicationNumber: row.application_number,
      customerName: row.customer_name,
      loanType,
      applicationStatus: row.status,
      commissionStatus: mapCommissionStatus(row.status, row),
      disbursedAmount: comm.base,
      disbursedAt: row.disbursed_at,
      commissionRatePercent: comm.rate,
      grossCommission: comm.gross,
      tdsAmount: comm.tds,
      netPayout: comm.net,
      agentCode: row.agent_code,
      agentName: row.agent_name,
      createdAt: row.created_at,
      generatedAt,
    };
  });

  // Merge Payable/Approved rows from referral_transactions ledger (source of truth for referral bills).
  let ledgerEntries = [];
  try {
    const { ensureReferralEngineSchema, listReferralTransactions } = await import('./referralEngine.js');
    await ensureReferralEngineSchema(pool);
    const ledgerRows = await listReferralTransactions(pool, {
      referrerUserId: agentId,
      referralType: 'agent',
      from: filters.from || undefined,
      to: filters.to || undefined,
      limit: 1000,
    });
    const billable = ledgerRows.filter((r) =>
      ['approved', 'payable', 'paid'].includes(String(r.payment_status || '')),
    );
    const allLedger = ledgerRows;
    const appNumbers = new Set(appEntries.map((e) => e.applicationNumber).filter(Boolean));
    ledgerEntries = billable
      .filter((r) => !r.application_number || !appNumbers.has(r.application_number))
      .map((r) => ({
        source: 'referral_ledger',
        applicationNumber: r.application_number || r.public_id,
        customerName: r.referrer_name || 'Referral',
        loanType: r.product || 'referral',
        applicationStatus: 'disbursed',
        commissionStatus:
          r.payment_status === 'paid'
            ? 'paid'
            : 'payable',
        disbursedAmount: Number(r.disbursed_amount || 0),
        disbursedAt: r.created_at,
        commissionRatePercent: r.commission_rate != null ? Number(r.commission_rate) : 0,
        grossCommission: Number(r.commission_amount || 0),
        tdsAmount: Number(r.tds_amount || 0),
        netPayout: Number(r.net_amount || 0),
        agentCode: null,
        agentName: null,
        createdAt: r.created_at,
        generatedAt,
        paymentStatus: r.payment_status,
        referralTransactionId: r.id,
      }));

    // Prefer ledger amounts when the same application exists in both sources.
    const ledgerByApp = new Map(
      allLedger.filter((r) => r.application_number).map((r) => [r.application_number, r]),
    );
    for (const entry of appEntries) {
      const lr = ledgerByApp.get(entry.applicationNumber);
      if (!lr) continue;
      entry.source = 'referral_ledger';
      entry.grossCommission = Number(lr.commission_amount || entry.grossCommission);
      entry.tdsAmount = Number(lr.tds_amount || entry.tdsAmount);
      entry.netPayout = Number(lr.net_amount || entry.netPayout);
      entry.disbursedAmount = Number(lr.disbursed_amount || entry.disbursedAmount);
      entry.commissionStatus =
        lr.payment_status === 'paid'
          ? 'paid'
          : ['approved', 'payable'].includes(lr.payment_status)
            ? 'payable'
            : entry.commissionStatus;
      entry.referralTransactionId = lr.id;
    }
  } catch {
    /* ledger optional until migrated */
  }

  return { generatedAt, entries: [...appEntries, ...ledgerEntries], config, filters };
}

export function commissionReportToCsv(report) {
  const header = [
    'application_number',
    'customer_name',
    'loan_type',
    'application_status',
    'commission_status',
    'disbursed_amount',
    'disbursed_at',
    'commission_rate_percent',
    'gross_commission',
    'tds_amount',
    'net_payout',
    'agent_code',
    'generated_at',
  ];
  const lines = [header.join(',')];
  for (const e of report.entries) {
    lines.push(
      [
        e.applicationNumber,
        `"${(e.customerName || '').replace(/"/g, '""')}"`,
        e.loanType,
        e.applicationStatus,
        e.commissionStatus,
        e.disbursedAmount,
        e.disbursedAt || '',
        e.commissionRatePercent,
        e.grossCommission,
        e.tdsAmount,
        e.netPayout,
        e.agentCode,
        e.generatedAt,
      ].join(','),
    );
  }
  return lines.join('\n');
}

export function commissionReportToPdf(report) {
  const lines = [
    'Rfincare — Agent Commission Report',
    `Generated: ${report.generatedAt}`,
    '',
    ...report.entries.map(
      (e, i) =>
        `${i + 1}. ${e.applicationNumber} | ${e.customerName} | ${e.loanType} | `
        + `Status ${e.applicationStatus} | Comm ${e.commissionStatus} | `
        + `Disbursed ${e.disbursedAmount} | Gross ${e.grossCommission} | TDS ${e.tdsAmount} | Net ${e.netPayout}`,
    ),
  ];
  return buildSimpleTextPdf(lines);
}

/**
 * Monthly commission bill / invoice PDF for Accounts Team emailing.
 * @param {object} report
 * @param {{ periodStart?: string, periodEnd?: string, notes?: string|null, agentName?: string, agentCode?: string }} [meta]
 */
export function commissionBillToPdf(report, meta = {}) {
  const summary = summarizeCommissionReport(report);
  const periodStart = meta.periodStart || report.filters?.from || '—';
  const periodEnd = meta.periodEnd || report.filters?.to || '—';
  const lines = [
    'Rfincare — Monthly Commission Bill',
    `Period: ${periodStart} to ${periodEnd}`,
    `Generated: ${report.generatedAt || new Date().toISOString()}`,
    meta.agentName ? `Agent: ${meta.agentName}` : '',
    meta.agentCode ? `Agent code: ${meta.agentCode}` : '',
    meta.notes ? `Notes: ${meta.notes}` : '',
    '',
    `Entries: ${summary.entryCount}`,
    `Gross commission: INR ${Number(summary.gross || 0).toLocaleString('en-IN')}`,
    `TDS (10%): INR ${Number(summary.tds || 0).toLocaleString('en-IN')}`,
    `Net payable: INR ${Number(summary.net || 0).toLocaleString('en-IN')}`,
    '',
    'Line items',
    '----------',
    ...(report.entries || []).map(
      (e, i) =>
        `${i + 1}. ${e.applicationNumber} | ${e.customerName} | ${e.loanType} | `
        + `${e.commissionStatus} | Disbursed ${e.disbursedAmount} | `
        + `Gross ${e.grossCommission} | TDS ${e.tdsAmount} | Net ${e.netPayout}`,
    ),
    '',
    'Instruction: Download this PDF and email it to the Accounts Team',
    'for commission processing and reconciliation.',
  ].filter((line) => line !== '');
  return buildSimpleTextPdf(lines);
}

export function commissionReportToXlsx(report) {
  const rows = (report.entries || []).map((e) => ({
    application_number: e.applicationNumber,
    customer_name: e.customerName,
    loan_type: e.loanType,
    application_status: e.applicationStatus,
    commission_status: e.commissionStatus,
    disbursed_amount: e.disbursedAmount,
    disbursed_at: e.disbursedAt || '',
    commission_rate_percent: e.commissionRatePercent,
    gross_commission: e.grossCommission,
    tds_amount: e.tdsAmount,
    net_payout: e.netPayout,
    agent_code: e.agentCode,
    generated_at: e.generatedAt,
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Commission');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

export function summarizeCommissionReport(report) {
  const entries = report.entries || [];
  const gross = entries.reduce((sum, e) => sum + Number(e.grossCommission || 0), 0);
  const tds = entries.reduce((sum, e) => sum + Number(e.tdsAmount || 0), 0);
  const net = entries.reduce((sum, e) => sum + Number(e.netPayout || 0), 0);
  return { entryCount: entries.length, gross, tds, net };
}
