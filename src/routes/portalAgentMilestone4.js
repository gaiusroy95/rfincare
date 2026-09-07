import { Router } from 'express';

import { authenticate } from '../middleware/authenticate.js';
import { getPool } from '../db/pool.js';
import { randomUUID } from 'node:crypto';

import {
  buildAgentCommissionReport,
  commissionReportToCsv,
  commissionReportToPdf,
  commissionBillToPdf,
  commissionReportToXlsx,
  summarizeCommissionReport,
} from '../lib/commissionReportService.js';
import { ensureMilestone4Schema } from '../db/ensureMilestone4Schema.js';

export const portalAgentMilestone4Router = Router();

portalAgentMilestone4Router.use(authenticate);

function downloadBlob(res, buffer, { mime, filename }) {
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(buffer);
}

async function loadAgentBillMeta(pool, agentId) {
  const [[row]] = await pool.execute(
    `SELECT up.full_name, ao.agent_name, ao.agent_code
     FROM user_profiles up
     LEFT JOIN agent_onboarding ao ON ao.user_id = up.id
     WHERE up.id = :id
     LIMIT 1`,
    { id: agentId },
  );
  return {
    agentName: row?.full_name || row?.agent_name || 'Agent',
    agentCode: row?.agent_code || null,
  };
}

portalAgentMilestone4Router.get('/notifications', async (req, res, next) => {
  try {
    if (req.auth.role !== 'agent' && !['admin', 'super_admin'].includes(req.auth.role)) {
      return res.status(403).json({ error: 'Agent access only' });
    }
    await ensureMilestone4Schema();
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT id, user_id, role, application_id, event_type, title, message, is_read, created_at
       FROM staff_notifications WHERE user_id = :uid ORDER BY created_at DESC LIMIT 100`,
      { uid: req.auth.userId },
    );
    res.json(rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      role: row.role,
      applicationId: row.application_id,
      eventType: row.event_type,
      title: row.title,
      message: row.message,
      isRead: !!row.is_read,
      createdAt: row.created_at,
    })));
  } catch (err) {
    next(err);
  }
});

portalAgentMilestone4Router.get('/commission-report', async (req, res, next) => {
  try {
    if (req.auth.role !== 'agent' && !['admin', 'super_admin'].includes(req.auth.role)) {
      return res.status(403).json({ error: 'Agent access only' });
    }
    await ensureMilestone4Schema();
    const agentId = req.query.agentId || req.auth.userId;
    if (req.auth.role === 'agent' && agentId !== req.auth.userId) {
      return res.status(403).json({ error: 'Cannot view other agent reports' });
    }

    const report = await buildAgentCommissionReport(agentId, {
      from: req.query.from || null,
      to: req.query.to || null,
      applicationStatus: req.query.applicationStatus || 'all',
      commissionStatus: req.query.commissionStatus || 'all',
      loanType: req.query.loanType || 'all',
    });

    const format = String(req.query.format || 'json').toLowerCase();
    if (format === 'xlsx' || format === 'excel') {
      const buf = commissionReportToXlsx(report);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="commission-report-${Date.now()}.xlsx"`,
      );
      return res.send(buf);
    }
    if (format === 'csv') {
      const csv = commissionReportToCsv(report);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="commission-report-${Date.now()}.csv"`,
      );
      return res.send(csv);
    }
    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="commission-report-${Date.now()}.pdf"`,
      );
      return res.send(commissionReportToPdf(report));
    }
    res.json(report);
  } catch (err) {
    next(err);
  }
});

portalAgentMilestone4Router.get('/commission-bills', async (req, res, next) => {
  try {
    if (req.auth.role !== 'agent' && !['admin', 'super_admin'].includes(req.auth.role)) {
      return res.status(403).json({ error: 'Agent access only' });
    }
    await ensureMilestone4Schema();
    const pool = getPool();
    const agentId = req.auth.userId;
    const [rows] = await pool.execute(
      `SELECT id, period_start, period_end, gross_amount, tds_amount, net_amount, status, notes, created_at
       FROM agent_commission_bills
       WHERE agent_user_id = :agentId
       ORDER BY created_at DESC
       LIMIT 50`,
      { agentId },
    );
    res.json(
      (rows || []).map((row) => ({
        id: row.id,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        grossAmount: Number(row.gross_amount || 0),
        tdsAmount: Number(row.tds_amount || 0),
        netAmount: Number(row.net_amount || 0),
        status: row.status,
        notes: row.notes,
        createdAt: row.created_at,
      })),
    );
  } catch (err) {
    next(err);
  }
});

portalAgentMilestone4Router.post('/commission-bills', async (req, res, next) => {
  try {
    if (req.auth.role !== 'agent') {
      return res.status(403).json({ error: 'Agent access only' });
    }
    await ensureMilestone4Schema();
    const pool = getPool();
    const agentId = req.auth.userId;
    const from = String(req.body?.from || '').trim();
    const to = String(req.body?.to || '').trim();
    const notes = String(req.body?.notes || '').trim() || null;
    if (!from || !to) {
      return res.status(400).json({
        error: 'Select From and To dates before raising a bill (YYYY-MM-DD).',
      });
    }
    if (from > to) {
      return res.status(400).json({ error: 'From date must be on or before To date.' });
    }

    const report = await buildAgentCommissionReport(agentId, {
      from,
      to,
      applicationStatus: 'all',
      commissionStatus: 'all',
      loanType: 'all',
    });
    const summary = summarizeCommissionReport(report);
    if (!summary.entryCount) {
      return res.status(400).json({
        error: 'No commission rows found for this period. Adjust the dates and try again.',
      });
    }

    const agentMeta = await loadAgentBillMeta(pool, agentId);
    const id = randomUUID();
    const snapshot = {
      generatedAt: report.generatedAt,
      entryCount: summary.entryCount,
      filters: { from, to },
      agent: agentMeta,
      notes,
      summary,
      entries: report.entries,
    };

    await pool.execute(
      `INSERT INTO agent_commission_bills
       (id, agent_user_id, period_start, period_end, gross_amount, tds_amount, net_amount, status, notes, report_snapshot)
       VALUES (:id, :agentId, :from, :to, :gross, :tds, :net, 'submitted', :notes, :snapshot)`,
      {
        id,
        agentId,
        from,
        to,
        gross: summary.gross,
        tds: summary.tds,
        net: summary.net,
        notes,
        snapshot: JSON.stringify(snapshot),
      },
    );

    const wantPdf =
      String(req.query.format || req.body?.format || '').toLowerCase() === 'pdf'
      || String(req.headers.accept || '').includes('application/pdf');

    if (wantPdf) {
      const pdf = commissionBillToPdf(report, {
        periodStart: from,
        periodEnd: to,
        notes,
        ...agentMeta,
      });
      return downloadBlob(res, pdf, {
        mime: 'application/pdf',
        filename: `commission-bill-${from}_to_${to}.pdf`,
      });
    }

    res.status(201).json({
      id,
      periodStart: from,
      periodEnd: to,
      grossAmount: summary.gross,
      tdsAmount: summary.tds,
      netAmount: summary.net,
      status: 'submitted',
      notes,
      entryCount: summary.entryCount,
      pdfPath: `/portal/agent/reports/commission-bills/${id}/pdf`,
      message:
        'Monthly commission bill generated. Download the PDF and email it to the Accounts Team for processing.',
    });
  } catch (err) {
    next(err);
  }
});

portalAgentMilestone4Router.get('/commission-bills/:id/pdf', async (req, res, next) => {
  try {
    if (req.auth.role !== 'agent' && !['admin', 'super_admin'].includes(req.auth.role)) {
      return res.status(403).json({ error: 'Agent access only' });
    }
    await ensureMilestone4Schema();
    const pool = getPool();
    const [[row]] = await pool.execute(
      `SELECT id, agent_user_id, period_start, period_end, notes, report_snapshot, created_at
       FROM agent_commission_bills
       WHERE id = :id
       LIMIT 1`,
      { id: req.params.id },
    );
    if (!row) {
      return res.status(404).json({ error: 'Commission bill not found' });
    }
    if (req.auth.role === 'agent' && row.agent_user_id !== req.auth.userId) {
      return res.status(403).json({ error: 'Cannot download another agent bill' });
    }

    let snapshot = row.report_snapshot;
    if (typeof snapshot === 'string') {
      try {
        snapshot = JSON.parse(snapshot);
      } catch {
        snapshot = null;
      }
    }

    const periodStart = String(row.period_start).slice(0, 10);
    const periodEnd = String(row.period_end).slice(0, 10);
    let report;
    if (snapshot?.entries?.length) {
      report = {
        generatedAt: snapshot.generatedAt || row.created_at,
        filters: snapshot.filters || { from: periodStart, to: periodEnd },
        entries: snapshot.entries,
      };
    } else {
      report = await buildAgentCommissionReport(row.agent_user_id, {
        from: periodStart,
        to: periodEnd,
        applicationStatus: 'all',
        commissionStatus: 'all',
        loanType: 'all',
      });
    }

    const agentMeta = snapshot?.agent || (await loadAgentBillMeta(pool, row.agent_user_id));
    const pdf = commissionBillToPdf(report, {
      periodStart,
      periodEnd,
      notes: row.notes,
      ...agentMeta,
    });
    return downloadBlob(res, pdf, {
      mime: 'application/pdf',
      filename: `commission-bill-${periodStart}_to_${periodEnd}.pdf`,
    });
  } catch (err) {
    next(err);
  }
});