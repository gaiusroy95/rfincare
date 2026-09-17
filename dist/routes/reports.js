import { Router } from "express";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { ensureMilestone3Schema } from "../db/ensureMilestone3Schema.js";
import { newId } from "../lib/ids.js";
import { authenticate } from "../middleware/authenticate.js";
import { authorize } from "../middleware/authorize.js";
import { generateReportSection } from "../lib/reportGenerators.js";
import { buildMasterReport } from "../lib/masterReport.js";
import { assertEmployeeAccess } from "../lib/employeeAccessControls.js";
const reportsRouter = Router();
async function enforceReportsAccess(req) {
  if (req.auth?.role === "employee") {
    await assertEmployeeAccess(req, "reports", "read");
  }
}
function formatSqlDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function parseYmdLocal(ymd) {
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return /* @__PURE__ */ new Date(NaN);
  return new Date(y, m - 1, d);
}
function dateRangeFromQuery(query) {
  const now = /* @__PURE__ */ new Date();
  if (query.startDate && query.endDate) {
    const start2 = parseYmdLocal(query.startDate);
    const end2 = parseYmdLocal(query.endDate);
    if (!Number.isNaN(start2.getTime()) && !Number.isNaN(end2.getTime())) {
      return { start: formatSqlDate(start2), end: formatSqlDate(end2) };
    }
  }
  let end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const range = query.dateRange || "last30days";
  switch (range) {
    case "today":
      break;
    case "yesterday":
      start.setDate(start.getDate() - 1);
      end.setDate(end.getDate() - 1);
      break;
    case "last7days":
      start.setDate(start.getDate() - 6);
      break;
    case "last30days":
      start.setDate(start.getDate() - 29);
      break;
    case "last90days":
      start.setDate(start.getDate() - 89);
      break;
    case "last365days":
      start.setDate(start.getDate() - 364);
      break;
    case "thisMonth":
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case "lastMonth":
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      end = new Date(now.getFullYear(), now.getMonth(), 0);
      break;
    case "thisQuarter": {
      const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
      start = new Date(now.getFullYear(), quarterStartMonth, 1);
      break;
    }
    case "thisYear":
      start = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      start.setDate(start.getDate() - 29);
      break;
  }
  return { start: formatSqlDate(start), end: formatSqlDate(end) };
}
const APPROVED_STATUSES = `('approved', 'disbursed', 'sanctioned', 'completed')`;
const PENDING_STATUSES = `('submitted', 'pending', 'under_review', 'documents_pending', 'in_review', 'processing')`;
const DOC_PENDING_STATUSES = `('pending', 'uploaded', 'submitted', 'awaiting_verification', 'under_review')`;
const REPORT_META = [
  { key: "application_volume", name: "Application Volume Report", category: "application" },
  {
    key: "agent_performance",
    name: "Agent Performance Dashboard Report",
    category: "agent"
  },
  { key: "financial_summary", name: "Financial Summary Report", category: "financial" },
  { key: "compliance_audit", name: "Compliance Audit Report", category: "compliance" },
  { key: "customer_analytics", name: "Customer Analytics Report", category: "customer" },
  { key: "bank_partnership", name: "Bank Partnership Report", category: "financial" },
  {
    key: "master",
    name: "Master Report (All Sections)",
    category: "application"
  }
];
reportsRouter.get(
  "/overview",
  authenticate,
  authorize({ resource: "reports", action: "read" }),
  async (req, res, next) => {
    try {
      await enforceReportsAccess(req);
      const pool = getPool();
      const { start, end } = dateRangeFromQuery(req.query);
      const startDate = parseYmdLocal(start);
      const endDate = parseYmdLocal(end);
      const spanDays = Math.max(
        1,
        Math.round((endDate.getTime() - startDate.getTime()) / 864e5) + 1
      );
      const prevEndDate = new Date(startDate);
      prevEndDate.setDate(prevEndDate.getDate() - 1);
      const prevStartDate = new Date(prevEndDate);
      prevStartDate.setDate(prevStartDate.getDate() - (spanDays - 1));
      const pStart = formatSqlDate(prevStartDate);
      const pEnd = formatSqlDate(prevEndDate);
      const rangeParams = { start, end };
      const prevParams = { start: pStart, end: pEnd };
      const [[cur]] = await pool.execute(
        `SELECT COUNT(*)::int AS total,
                SUM(CASE WHEN LOWER(COALESCE(status, '')) IN ${APPROVED_STATUSES} THEN 1 ELSE 0 END)::int AS approved,
                SUM(CASE WHEN LOWER(COALESCE(status, '')) IN ${PENDING_STATUSES} THEN 1 ELSE 0 END)::int AS pending
         FROM loan_applications
         WHERE created_at::date BETWEEN :start::date AND :end::date`,
        rangeParams
      );
      const [[prev]] = await pool.execute(
        `SELECT COUNT(*)::int AS total,
                SUM(CASE WHEN LOWER(COALESCE(status, '')) IN ${APPROVED_STATUSES} THEN 1 ELSE 0 END)::int AS approved
         FROM loan_applications
         WHERE created_at::date BETWEEN :start::date AND :end::date`,
        prevParams
      );
      const [[agents]] = await pool.execute(
        `SELECT COUNT(*)::int AS active_agents FROM user_profiles
         WHERE role = 'agent'
           AND COALESCE(is_active, TRUE) = TRUE
           AND COALESCE(account_status, 'active') NOT IN ('suspended', 'inactive', 'terminated')`
      );
      const [[newAgents]] = await pool.execute(
        `SELECT COUNT(*)::int AS cnt FROM user_profiles
         WHERE role = 'agent' AND created_at::date BETWEEN :start::date AND :end::date`,
        rangeParams
      );
      const [[customers]] = await pool.execute(
        `SELECT
           COUNT(*) FILTER (
             WHERE COALESCE(is_active, TRUE) = TRUE
               AND COALESCE(account_status, 'active') NOT IN ('suspended', 'inactive', 'terminated')
           )::int AS active_customers,
           COUNT(*) FILTER (
             WHERE created_at::date BETWEEN :start::date AND :end::date
           )::int AS new_customers
         FROM user_profiles
         WHERE role = 'customer'`,
        rangeParams
      );
      let docsPending = 0;
      try {
        const [[docs]] = await pool.execute(
          `SELECT COUNT(*)::int AS c FROM customer_documents
           WHERE (
             LOWER(COALESCE(verification_status, 'pending')) IN ${DOC_PENDING_STATUSES}
             OR verification_status IS NULL
           )
           AND (
             created_at IS NULL
             OR created_at::date BETWEEN :start::date AND :end::date
             OR updated_at::date BETWEEN :start::date AND :end::date
           )`,
          rangeParams
        );
        docsPending = Number(docs?.c || 0);
      } catch {
        try {
          const [[docs]] = await pool.execute(
            `SELECT COUNT(*)::int AS c FROM customer_documents
             WHERE LOWER(COALESCE(verification_status, 'pending')) IN ${DOC_PENDING_STATUSES}
                OR verification_status IS NULL`
          );
          docsPending = Number(docs?.c || 0);
        } catch {
          docsPending = 0;
        }
      }
      const total = Number(cur?.total || 0);
      const approved = Number(cur?.approved || 0);
      const pending = Number(cur?.pending || 0);
      const prevTotal = Number(prev?.total || 0);
      const prevApproved = Number(prev?.approved || 0);
      const activeCustomers = Number(customers?.active_customers || 0);
      const newCustomers = Number(customers?.new_customers || 0);
      const activeAgents = Number(agents?.active_agents || 0);
      const agentsJoined = Number(newAgents?.cnt || 0);
      const pctChange = (curVal, prevVal) => {
        if (!prevVal) return curVal ? "+100%" : "0%";
        const d = (curVal - prevVal) / prevVal * 100;
        return `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`;
      };
      const approvalRate = total > 0 ? (approved / total * 100).toFixed(1) : "0.0";
      const prevApprovalRate = prevTotal > 0 ? prevApproved / prevTotal * 100 : 0;
      const curApprovalRate = total > 0 ? approved / total * 100 : 0;
      res.json({
        period: { start, end, previousStart: pStart, previousEnd: pEnd },
        metrics: [
          {
            id: 1,
            label: "Total Applications",
            value: total.toLocaleString("en-IN"),
            change: pctChange(total, prevTotal),
            trend: total >= prevTotal ? "up" : "down",
            icon: "FileText",
            color: "#2563eb",
            subtitle: "vs. previous period"
          },
          {
            id: 2,
            label: "Approval Rate",
            value: `${approvalRate}%`,
            change: pctChange(curApprovalRate, prevApprovalRate),
            trend: curApprovalRate >= prevApprovalRate ? "up" : "down",
            icon: "CheckCircle",
            color: "#059669",
            subtitle: `${approved.toLocaleString("en-IN")} approved in period`
          },
          {
            id: 3,
            label: "Active Agents",
            value: String(activeAgents),
            change: agentsJoined ? `+${agentsJoined}` : "0",
            trend: agentsJoined > 0 ? "up" : "neutral",
            icon: "Users",
            color: "#7c3aed",
            subtitle: `New in period: ${agentsJoined}`
          },
          {
            id: 4,
            label: "Pending Reviews",
            value: String(pending),
            change: "",
            trend: "neutral",
            icon: "Clock",
            color: "#f59e0b",
            subtitle: "Awaiting decision"
          },
          {
            id: 5,
            label: "Active Customers",
            value: String(activeCustomers),
            change: newCustomers ? `+${newCustomers}` : "0",
            trend: newCustomers > 0 ? "up" : "up",
            icon: "UserCheck",
            color: "#0ea5e9",
            subtitle: newCustomers ? `${newCustomers} registered in period` : "Registered customers"
          },
          {
            id: 6,
            label: "Documents Pending",
            value: String(docsPending),
            change: "",
            trend: "neutral",
            icon: "FileText",
            color: "#ef4444",
            subtitle: "Awaiting verification"
          }
        ]
      });
    } catch (err) {
      next(err);
    }
  }
);
reportsRouter.get(
  "/charts/application-volume",
  authenticate,
  authorize({ resource: "reports", action: "read" }),
  async (req, res, next) => {
    try {
      await enforceReportsAccess(req);
      const pool = getPool();
      const { start, end } = dateRangeFromQuery(req.query);
      const volumeSql = `SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') AS month,
                  EXTRACT(MONTH FROM created_at)::int AS m,
                  EXTRACT(YEAR FROM created_at)::int AS y,
                  COUNT(*)::int AS submitted,
                  SUM(CASE WHEN LOWER(COALESCE(status, '')) IN ${APPROVED_STATUSES} THEN 1 ELSE 0 END)::int AS approved,
                  SUM(CASE WHEN LOWER(COALESCE(status, '')) IN ('rejected', 'declined', 'cancelled') THEN 1 ELSE 0 END)::int AS rejected,
                  SUM(CASE WHEN LOWER(COALESCE(status, '')) IN ${PENDING_STATUSES} THEN 1 ELSE 0 END)::int AS pending
           FROM loan_applications
           WHERE created_at::date BETWEEN :start::date AND :end::date
           GROUP BY DATE_TRUNC('month', created_at), EXTRACT(YEAR FROM created_at), EXTRACT(MONTH FROM created_at), TO_CHAR(DATE_TRUNC('month', created_at), 'Mon')
           ORDER BY y, m`;
      const [rows] = await pool.execute(volumeSql, { start, end });
      res.json(rows);
    } catch (err) {
      next(err);
    }
  }
);
reportsRouter.get(
  "/charts/agent-performance",
  authenticate,
  authorize({ resource: "reports", action: "read" }),
  async (req, res, next) => {
    try {
      await enforceReportsAccess(req);
      const pool = getPool();
      const { start, end } = dateRangeFromQuery(req.query);
      const [rows] = await pool.execute(
        `SELECT up.full_name AS name,
                COUNT(la.id)::int AS clients,
                SUM(CASE WHEN LOWER(COALESCE(la.status, '')) IN ${APPROVED_STATUSES} THEN 1 ELSE 0 END)::int AS conversions
         FROM user_profiles up
         LEFT JOIN loan_applications la
           ON la.agent_id = up.id
          AND la.created_at::date BETWEEN :start::date AND :end::date
         WHERE up.role = 'agent' AND COALESCE(up.is_active, TRUE) = TRUE
         GROUP BY up.id, up.full_name
         HAVING COUNT(la.id) > 0
         ORDER BY conversions DESC, clients DESC
         LIMIT 12`,
        { start, end }
      );
      res.json(
        rows.map((r) => ({
          name: r.name || "Agent",
          clients: Number(r.clients || 0),
          conversions: Number(r.conversions || 0),
          successRate: Number(r.clients || 0) > 0 ? Number((Number(r.conversions || 0) / Number(r.clients || 0) * 100).toFixed(1)) : 0,
          earnings: Number(r.conversions || 0) * 2500
        }))
      );
    } catch (err) {
      next(err);
    }
  }
);
reportsRouter.get(
  "/charts/revenue-distribution",
  authenticate,
  authorize({ resource: "reports", action: "read" }),
  async (req, res, next) => {
    try {
      await enforceReportsAccess(req);
      const pool = getPool();
      const { start, end } = dateRangeFromQuery(req.query);
      let rows = [];
      try {
        const [r] = await pool.execute(
          `SELECT COALESCE(NULLIF(TRIM(loan_type), ''), NULLIF(TRIM(data->>'loan_type'), ''), 'other') AS loan_type,
                  COUNT(*)::int AS count
           FROM loan_applications
           WHERE created_at::date BETWEEN :start::date AND :end::date
           GROUP BY 1
           ORDER BY count DESC`,
          { start, end }
        );
        rows = r;
      } catch {
        const [r] = await pool.execute(
          `SELECT COALESCE(NULLIF(TRIM(loan_type), ''), 'other') AS loan_type,
                  COUNT(*)::int AS count
           FROM loan_applications
           WHERE created_at::date BETWEEN :start::date AND :end::date
           GROUP BY 1
           ORDER BY count DESC`,
          { start, end }
        );
        rows = r;
      }
      const colors = ["#3b82f6", "#10b981", "#f59e0b", "#8b5cf6", "#ef4444"];
      res.json(
        rows.map((r, i) => ({
          name: String(r.loan_type || "other").replace(/_/g, " "),
          value: Number(r.count || 0),
          color: colors[i % colors.length]
        }))
      );
    } catch (err) {
      next(err);
    }
  }
);
reportsRouter.get(
  "/catalog",
  authenticate,
  authorize({ resource: "reports", action: "read" }),
  async (req, res, next) => {
    try {
      await enforceReportsAccess(req);
      await ensureMilestone3Schema();
      const pool = getPool();
      const [schedules] = await pool.execute(
        `SELECT report_key, MAX(last_run_at) AS last_run_at
         FROM report_schedules WHERE is_active = TRUE GROUP BY report_key`
      );
      const scheduleMap = Object.fromEntries(
        schedules.map((s) => [s.report_key, s.last_run_at])
      );
      const [activeSchedules] = await pool.execute(
        `SELECT report_key FROM report_schedules WHERE is_active = TRUE`
      );
      const scheduledKeys = new Set(activeSchedules.map((s) => s.report_key));
      res.json(
        REPORT_META.map((r, idx) => ({
          id: idx + 1,
          key: r.key,
          name: r.name,
          category: r.category,
          frequency: "On demand",
          lastGenerated: scheduleMap[r.key] ? new Date(scheduleMap[r.key]).toISOString() : null,
          isScheduled: scheduledKeys.has(r.key)
        }))
      );
    } catch (err) {
      next(err);
    }
  }
);
reportsRouter.get(
  "/generate/:reportKey",
  authenticate,
  authorize({ resource: "reports", action: "read" }),
  async (req, res, next) => {
    try {
      await enforceReportsAccess(req);
      const { reportKey } = req.params;
      const pool = getPool();
      const { start, end } = dateRangeFromQuery(req.query);
      const params = { start, end };
      if (reportKey === "master") {
        const master = await buildMasterReport(pool, params, {
          startDate: req.query.startDate,
          endDate: req.query.endDate
        });
        return res.json(master);
      }
      const { columns, rows } = await generateReportSection(pool, reportKey, params);
      res.json({
        reportKey,
        columns,
        rows,
        generatedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
    } catch (err) {
      next(err);
    }
  }
);
const ScheduleSchema = z.object({
  reportKey: z.string().min(1),
  reportName: z.string().min(1),
  frequency: z.enum(["daily", "weekly", "monthly"]),
  format: z.enum(["csv", "pdf", "xlsx"]).default("csv"),
  recipients: z.string().min(3),
  filters: z.record(z.unknown()).optional()
});
reportsRouter.get(
  "/schedules",
  authenticate,
  authorize({ resource: "reports", action: "read" }),
  async (req, res, next) => {
    try {
      await enforceReportsAccess(req);
      await ensureMilestone3Schema();
      const pool = getPool();
      const [rows] = await pool.execute(
        `SELECT * FROM report_schedules WHERE is_active = TRUE ORDER BY created_at DESC`
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  }
);
reportsRouter.post(
  "/schedules",
  authenticate,
  authorize({ resource: "reports", action: "read" }),
  async (req, res, next) => {
    try {
      await enforceReportsAccess(req);
      await ensureMilestone3Schema();
      const input = ScheduleSchema.parse(req.body);
      const pool = getPool();
      const id = newId();
      await pool.execute(
        `INSERT INTO report_schedules (
           id, report_key, report_name, frequency, format, recipients, filters_json, created_by
         ) VALUES (
           :id, :report_key, :report_name, :frequency, :format, :recipients, :filters_json, :created_by
         )`,
        {
          id,
          report_key: input.reportKey,
          report_name: input.reportName,
          frequency: input.frequency,
          format: input.format,
          recipients: input.recipients,
          filters_json: input.filters ? JSON.stringify(input.filters) : null,
          created_by: req.auth.userId
        }
      );
      res.status(201).json({ id, ok: true });
    } catch (err) {
      next(err);
    }
  }
);
export {
  reportsRouter
};
