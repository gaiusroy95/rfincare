import { Router } from 'express';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { ensureMilestone3Schema } from '../db/ensureMilestone3Schema.js';
import { newId } from '../lib/ids.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { generateReportSection } from '../lib/reportGenerators.js';
import { buildMasterReport } from '../lib/masterReport.js';
import {
  normalizeFormat,
  runDueReportSchedules,
  sendScheduledReportEmail,
} from '../lib/reportScheduleRunner.js';

export const reportsRouter = Router();

function titleCaseFrequency(frequency) {
  const value = String(frequency || '').trim();
  if (!value) return 'On demand';
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function formatSqlDateTime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function dateRangeFromQuery(query) {
  const now = new Date();

  if (query.startDate && query.endDate) {
    const start = new Date(query.startDate);
    const end = new Date(query.endDate);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    return { start: formatSqlDateTime(start), end: formatSqlDateTime(end) };
  }

  let end = new Date(now);
  let start = new Date(now);
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);

  const range = query.dateRange || 'last30days';

  switch (range) {
    case 'today':
      break;
    case 'yesterday':
      start.setDate(start.getDate() - 1);
      end.setDate(end.getDate() - 1);
      break;
    case 'last7days':
      start.setDate(start.getDate() - 6);
      break;
    case 'last30days':
      start.setDate(start.getDate() - 29);
      break;
    case 'last90days':
      start.setDate(start.getDate() - 89);
      break;
    case 'last365days':
      start.setDate(start.getDate() - 364);
      break;
    case 'thisMonth':
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'lastMonth':
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      break;
    case 'thisQuarter': {
      const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
      start = new Date(now.getFullYear(), quarterStartMonth, 1);
      break;
    }
    case 'thisYear':
      start = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      start.setDate(start.getDate() - 29);
      break;
  }

  return { start: formatSqlDateTime(start), end: formatSqlDateTime(end) };
}

const REPORT_META = [
  { key: 'application_volume', name: 'Application Volume Report', category: 'application' },
  {
    key: 'agent_performance',
    name: 'Agent Performance Dashboard Report',
    category: 'agent',
  },
  { key: 'financial_summary', name: 'Financial Summary Report', category: 'financial' },
  { key: 'compliance_audit', name: 'Compliance Audit Report', category: 'compliance' },
  { key: 'customer_analytics', name: 'Customer Analytics Report', category: 'customer' },
  { key: 'bank_partnership', name: 'Bank Partnership Report', category: 'financial' },
  {
    key: 'master',
    name: 'Master Report (All Sections)',
    category: 'application',
  },
];

reportsRouter.get(
  '/overview',
  authenticate,
  authorize({ resource: 'reports', action: 'read' }),
  async (req, res, next) => {
    try {
      const pool = getPool();
      const { start, end } = dateRangeFromQuery(req.query);
      const prevStart = new Date(start);
      const prevEnd = new Date(end);
      const spanMs = new Date(end) - new Date(start);
      prevStart.setTime(prevStart.getTime() - spanMs);
      prevEnd.setTime(prevEnd.getTime() - spanMs);

      const [[cur]] = await pool.execute(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
                SUM(CASE WHEN status IN ('submitted','pending','under_review') THEN 1 ELSE 0 END) AS pending
         FROM loan_applications
         WHERE created_at BETWEEN :start AND :end`,
        { start, end },
      );

      const [[prev]] = await pool.execute(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved
         FROM loan_applications
         WHERE created_at BETWEEN :pStart AND :pEnd`,
        { pStart: prevStart.toISOString().slice(0, 19).replace('T', ' '), pEnd: prevEnd.toISOString().slice(0, 19).replace('T', ' ') },
      );

      const [[agents]] = await pool.execute(
        `SELECT COUNT(*) AS active_agents FROM user_profiles
         WHERE role = 'agent' AND is_active = TRUE AND account_status = 'active'`,
      );

      const [[newAgents]] = await pool.execute(
        `SELECT COUNT(*) AS cnt FROM user_profiles
         WHERE role = 'agent' AND created_at BETWEEN :start AND :end`,
        { start, end },
      );

      const total = Number(cur?.total || 0);
      const approved = Number(cur?.approved || 0);
      const prevTotal = Number(prev?.total || 0);
      const pctChange = (curVal, prevVal) => {
        if (!prevVal) return curVal ? '+100%' : '0%';
        const d = ((curVal - prevVal) / prevVal) * 100;
        return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
      };

      const approvalRate = total > 0 ? ((approved / total) * 100).toFixed(1) : '0';

      res.json({
        metrics: [
          {
            id: 1,
            label: 'Total Applications',
            value: total.toLocaleString('en-IN'),
            change: pctChange(total, prevTotal),
            trend: total >= prevTotal ? 'up' : 'down',
            icon: 'FileText',
            subtitle: 'vs. previous period',
          },
          {
            id: 2,
            label: 'Approval Rate',
            value: `${approvalRate}%`,
            change: pctChange(approved, Number(prev?.approved || 0)),
            trend: 'up',
            icon: 'CheckCircle',
            subtitle: `${approved} approved in period`,
          },
          {
            id: 3,
            label: 'Active Agents',
            value: String(Number(agents?.active_agents || 0)),
            change: `+${Number(newAgents?.cnt || 0)}`,
            trend: 'up',
            icon: 'Users',
            subtitle: `New in period: ${Number(newAgents?.cnt || 0)}`,
          },
          {
            id: 4,
            label: 'Pending Reviews',
            value: String(Number(cur?.pending || 0)),
            change: '',
            trend: 'neutral',
            icon: 'Clock',
            subtitle: 'Awaiting decision',
          },
          {
            id: 5,
            label: 'Active Customers',
            value: String(
              (
                await pool.execute(
                  `SELECT COUNT(*) AS c FROM user_profiles WHERE role = 'customer' AND is_active = TRUE`,
                )
              )[0][0]?.c || 0,
            ),
            change: '',
            trend: 'up',
            icon: 'UserCheck',
            subtitle: 'Registered customers',
          },
          {
            id: 6,
            label: 'Documents Pending',
            value: String(
              (
                await pool.execute(
                  `SELECT COUNT(*) AS c FROM customer_documents
                   WHERE verification_status IN ('pending','uploaded') OR verification_status IS NULL`,
                )
              )[0][0]?.c || 0,
            ),
            change: '',
            trend: 'neutral',
            icon: 'FileText',
            subtitle: 'Awaiting verification',
          },
        ],
      });
    } catch (err) {
      next(err);
    }
  },
);

reportsRouter.get(
  '/charts/application-volume',
  authenticate,
  authorize({ resource: 'reports', action: 'read' }),
  async (req, res, next) => {
    try {
      const pool = getPool();
      const volumeSql = `SELECT TO_CHAR(created_at, 'Mon') AS month,
                  EXTRACT(MONTH FROM created_at)::int AS m,
                  EXTRACT(YEAR FROM created_at)::int AS y,
                  COUNT(*) AS submitted,
                  SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
                  SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
                  SUM(CASE WHEN status IN ('draft','submitted','pending','under_review') THEN 1 ELSE 0 END) AS pending
           FROM loan_applications
           WHERE created_at >= NOW() - INTERVAL '12 months'
           GROUP BY EXTRACT(YEAR FROM created_at), EXTRACT(MONTH FROM created_at), TO_CHAR(created_at, 'Mon')
           ORDER BY y, m`;
      const [rows] = await pool.execute(volumeSql);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  },
);

reportsRouter.get(
  '/charts/agent-performance',
  authenticate,
  authorize({ resource: 'reports', action: 'read' }),
  async (req, res, next) => {
    try {
      const pool = getPool();
      const [rows] = await pool.execute(
        `SELECT up.full_name AS name,
                COUNT(la.id) AS clients,
                SUM(CASE WHEN la.status = 'approved' THEN 1 ELSE 0 END) AS conversions
         FROM user_profiles up
         LEFT JOIN loan_applications la ON la.agent_id = up.id
         WHERE up.role = 'agent' AND up.is_active = TRUE
         GROUP BY up.id, up.full_name
         ORDER BY conversions DESC
         LIMIT 12`,
      );
      res.json(
        rows.map((r) => ({
          name: r.name || 'Agent',
          clients: Number(r.clients || 0),
          conversions: Number(r.conversions || 0),
          successRate:
            Number(r.clients || 0) > 0
              ? Number(((Number(r.conversions || 0) / Number(r.clients || 0)) * 100).toFixed(1))
              : 0,
          earnings: Number(r.conversions || 0) * 2500,
        })),
      );
    } catch (err) {
      next(err);
    }
  },
);

reportsRouter.get(
  '/charts/revenue-distribution',
  authenticate,
  authorize({ resource: 'reports', action: 'read' }),
  async (req, res, next) => {
    try {
      const pool = getPool();
      const [rows] = await pool.execute(
        `SELECT COALESCE(data->>'loan_type', 'personal') AS loan_type,
                COUNT(*) AS count
         FROM loan_applications
         GROUP BY loan_type`,
      );
      const colors = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444'];
      res.json(
        rows.map((r, i) => ({
          name: String(r.loan_type || 'other').replace(/_/g, ' '),
          value: Number(r.count || 0),
          color: colors[i % colors.length],
        })),
      );
    } catch (err) {
      next(err);
    }
  },
);

reportsRouter.get(
  '/catalog',
  authenticate,
  authorize({ resource: 'reports', action: 'read' }),
  async (req, res, next) => {
    try {
      await ensureMilestone3Schema();
      const pool = getPool();
      const [activeSchedules] = await pool.execute(
        `SELECT DISTINCT ON (report_key)
            report_key, frequency, last_run_at
         FROM report_schedules
         WHERE is_active = TRUE
         ORDER BY report_key, created_at DESC`,
      );
      const scheduleMap = Object.fromEntries(
        activeSchedules.map((s) => [
          s.report_key,
          { frequency: s.frequency, last_run_at: s.last_run_at },
        ]),
      );

      res.json(
        REPORT_META.map((r, idx) => {
          const schedule = scheduleMap[r.key];
          return {
            id: idx + 1,
            key: r.key,
            name: r.name,
            category: r.category,
            frequency: schedule ? titleCaseFrequency(schedule.frequency) : 'On demand',
            lastGenerated: schedule?.last_run_at
              ? new Date(schedule.last_run_at).toISOString()
              : null,
            isScheduled: Boolean(schedule),
          };
        }),
      );
    } catch (err) {
      next(err);
    }
  },
);

reportsRouter.get(
  '/generate/:reportKey',
  authenticate,
  authorize({ resource: 'reports', action: 'read' }),
  async (req, res, next) => {
    try {
      const { reportKey } = req.params;
      const pool = getPool();
      const { start, end } = dateRangeFromQuery(req.query);
      const params = { start, end };

      if (reportKey === 'master') {
        const master = await buildMasterReport(pool, params, {
          startDate: req.query.startDate,
          endDate: req.query.endDate,
        });
        return res.json(master);
      }

      const { columns, rows } = await generateReportSection(pool, reportKey, params);

      res.json({
        reportKey,
        columns,
        rows,
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  },
);

const ScheduleSchema = z.object({
  reportKey: z.string().min(1),
  reportName: z.string().min(1),
  frequency: z.enum(['daily', 'weekly', 'monthly', 'quarterly']),
  format: z.enum(['csv', 'pdf', 'xlsx', 'excel']).default('csv'),
  recipients: z.string().min(3),
  filters: z.record(z.unknown()).optional(),
  dayOfWeek: z.string().optional(),
  time: z.string().optional(),
  dayOfMonth: z.coerce.number().int().min(1).max(28).optional(),
  autoSend: z.boolean().optional(),
  includeCharts: z.boolean().optional(),
});

reportsRouter.get(
  '/schedules',
  authenticate,
  authorize({ resource: 'reports', action: 'read' }),
  async (req, res, next) => {
    try {
      await ensureMilestone3Schema();
      const pool = getPool();
      const [rows] = await pool.execute(
        `SELECT * FROM report_schedules WHERE is_active = TRUE ORDER BY created_at DESC`,
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  },
);

reportsRouter.post(
  '/schedules',
  authenticate,
  authorize({ resource: 'reports', action: 'read' }),
  async (req, res, next) => {
    try {
      await ensureMilestone3Schema();
      const input = ScheduleSchema.parse(req.body);
      const pool = getPool();
      const id = newId();
      const format = normalizeFormat(input.format);
      const filtersJson = {
        ...(input.filters || {}),
        dayOfWeek: input.dayOfWeek || input.filters?.dayOfWeek || 'monday',
        time: input.time || input.filters?.time || '09:00',
        dayOfMonth: input.dayOfMonth || input.filters?.dayOfMonth || 1,
        autoSend: input.autoSend !== false,
        includeCharts: Boolean(input.includeCharts),
      };

      await pool.execute(
        `INSERT INTO report_schedules (
           id, report_key, report_name, frequency, format, recipients, filters_json, created_by
         ) VALUES (
           :id, :report_key, :report_name, :frequency, :format, :recipients, :filters_json::jsonb, :created_by
         )`,
        {
          id,
          report_key: input.reportKey,
          report_name: input.reportName,
          frequency: input.frequency,
          format,
          recipients: input.recipients,
          filters_json: JSON.stringify(filtersJson),
          created_by: req.auth.userId,
        },
      );

      const schedule = {
        id,
        report_key: input.reportKey,
        report_name: input.reportName,
        frequency: input.frequency,
        format,
        recipients: input.recipients,
        filters_json: filtersJson,
        last_run_at: null,
      };

      let delivery = null;
      if (filtersJson.autoSend) {
        delivery = await sendScheduledReportEmail(pool, schedule, { force: true });
      }

      res.status(201).json({
        id,
        ok: true,
        delivery,
        warning: delivery && !delivery.ok ? delivery.warning || delivery.reason : undefined,
      });
    } catch (err) {
      next(err);
    }
  },
);

reportsRouter.post(
  '/schedules/:id/run',
  authenticate,
  authorize({ resource: 'reports', action: 'read' }),
  async (req, res, next) => {
    try {
      await ensureMilestone3Schema();
      const pool = getPool();
      const [rows] = await pool.execute(
        `SELECT * FROM report_schedules WHERE id = :id AND is_active = TRUE LIMIT 1`,
        { id: req.params.id },
      );
      const schedule = rows[0];
      if (!schedule) {
        return res.status(404).json({ error: 'Schedule not found' });
      }
      const delivery = await sendScheduledReportEmail(pool, schedule, { force: true });
      res.json({ ok: delivery.ok, delivery });
    } catch (err) {
      next(err);
    }
  },
);

reportsRouter.get('/cron/run', async (req, res, next) => {
  try {
    const secret = process.env.REPORTS_CRON_SECRET || process.env.ENGAGEMENT_CRON_SECRET;
    const header = req.get('X-Reports-Cron-Secret') || req.get('X-Engagement-Cron-Secret') || req.query.secret;
    if (!secret || header !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    await ensureMilestone3Schema();
    const pool = getPool();
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const forceAll = String(req.query.force || '') === '1';
    const result = await runDueReportSchedules(pool, { limit, forceAll });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});
