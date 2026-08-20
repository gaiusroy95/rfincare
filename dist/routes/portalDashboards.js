import { Router } from "express";
import { getPool } from "../db/pool.js";
import { authenticate } from "../middleware/authenticate.js";
import { ensureStaffExtrasSchema } from "../db/ensureStaffExtrasSchema.js";
import {
  calculateCommissionFromApplication,
  commissionStatusForApplication
} from "../lib/agentCustomerProvision.js";
import { getAgentLearningFeed } from "./agentLearning.js";
import { getEmployeeLearningFeed } from "./employeeLearning.js";
import {
  employeeHasModulePermission,
  getEffectiveEmployeeAccess
} from "../lib/employeeAccessControls.js";
import { ensureAgentLearningSchema } from "../db/ensureAgentLearningSchema.js";
import { ensureAgentProfileSchema } from "../db/ensureAgentProfileSchema.js";
import { ensureAgentCodeForUser } from "../lib/agentCode.js";
import {
  buildAgentPerformanceAnalytics,
  buildAgentMetricTrends
} from "../lib/agentPerformanceAnalytics.js";
import { fetchAgentCommissionCirculars } from "../lib/agentCommission.js";
import {
  fetchAgentCommissionLedger,
  mapLedgerEntryToCommission
} from "../lib/agentCommissionLedger.js";
import { buildAgentRecentActivities } from "../lib/agentRecentActivities.js";
const portalDashboardsRouter = Router();
function mapAppToClient(row) {
  const data = typeof row.data === "string" ? JSON.parse(row.data || "{}") : row.data || {};
  const statusMap = {
    draft: "new",
    submitted: "in-progress",
    pending: "in-progress",
    under_review: "in-progress",
    approved: "submitted",
    rejected: "submitted"
  };
  const rawStatus = row.status || "draft";
  const loanAmountValue = data.requested_loan_amount || data.requestedLoanAmount || data.loan_amount || data.loanAmount || null;
  return {
    id: row.id,
    kind: "application",
    name: row.customer_full_name || data.full_name || data.fullName || "Customer",
    loanType: data.loan_type_label || data.loan_type || data.loanPurpose || "Loan",
    amount: loanAmountValue ? `₹${Number(loanAmountValue).toLocaleString("en-IN")}` : "—",
    loanAmountValue: loanAmountValue != null ? Number(loanAmountValue) : null,
    status: statusMap[rawStatus] || "in-progress",
    priority: data.admin_priority || "medium",
    daysActive: row.created_at ? `${Math.max(0, Math.floor((Date.now() - new Date(row.created_at)) / 864e5))} days ago` : "",
    nextAction: rawStatus === "approved" ? "Completed" : "Follow up",
    applicationNumber: row.application_number,
    rawStatus,
    email: row.customer_email || data.email || null,
    phone: row.customer_phone || data.phone || data.mobile || null,
    submittedAt: row.submitted_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    documentStage: row.document_stage_status || null,
    bankApprovalStatus: row.bank_approval_status || null,
    eligibilityStatus: row.eligibility_status || null,
    sourcedAgentCode: row.sourced_agent_code || null,
    selectedBankId: row.selected_bank_id || null
  };
}
function formatLoanTypeLabel(value) {
  if (!value) return "Prospect";
  return String(value).replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
function mapLeadToPipelineClient(row) {
  const statusMap = {
    new: "new",
    verified: "new",
    assigned: "in-progress",
    contacted: "in-progress",
    in_progress: "in-progress",
    converted: "submitted",
    closed: "submitted"
  };
  const leadStatus = String(row.status || "new").toLowerCase();
  return {
    id: row.id,
    kind: "lead",
    leadId: row.id,
    name: row.full_name || row.email || "Lead",
    loanType: formatLoanTypeLabel(row.loan_type),
    amount: "—",
    status: row.application_id ? "in-progress" : statusMap[leadStatus] || "new",
    priority: "medium",
    daysActive: row.created_at ? `${Math.max(0, Math.floor((Date.now() - new Date(row.created_at)) / 864e5))} days ago` : "",
    nextAction: row.application_id ? "Continue application" : "Start application",
    applicationId: row.application_id || null,
    email: row.email,
    phone: row.phone,
    rawStatus: leadStatus,
    source: row.source || "Website",
    createdAt: row.created_at || null,
    followUpAt: row.updated_at || row.created_at || null
  };
}
function parseJsonSafe(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
function normalizeAgentCode(value) {
  return String(value || "").trim().toLowerCase();
}
function stagePriorityOrder(row) {
  const status = String(row?.status || "").toLowerCase();
  const docStage = String(row?.document_stage_status || "").toLowerCase();
  const bankStage = String(row?.bank_approval_status || "").toLowerCase();
  if (["documents_pending", "pending", "uploaded", "in_review"].includes(docStage)) return 1;
  if (["submitted_to_bank", "under_review", "bank_review"].includes(bankStage)) return 2;
  if (["approved", "rejected", "completed"].includes(status)) return 3;
  if (["submitted", "pending", "under_review", "draft"].includes(status)) return 1;
  return 2;
}
function resolveResponsibleEmployeeIdForStage(app, hierarchyRows = []) {
  if (!hierarchyRows.length) return app.assigned_employee_id || null;
  const sorted = [...hierarchyRows].sort((a, b) => {
    const la = Number(a.hierarchy_level || 999);
    const lb = Number(b.hierarchy_level || 999);
    if (la !== lb) return la - lb;
    if (Boolean(a.is_primary) !== Boolean(b.is_primary)) return a.is_primary ? -1 : 1;
    return String(a.employee_user_id || "").localeCompare(String(b.employee_user_id || ""));
  });
  const targetIdx = Math.max(0, Math.min(sorted.length - 1, stagePriorityOrder(app) - 1));
  return sorted[targetIdx]?.employee_user_id || app.assigned_employee_id || null;
}
async function filterApplicationsForEmployeeByHierarchy(pool, employeeId, apps = []) {
  const rows = Array.isArray(apps) ? apps : [];
  if (!rows.length) return [];
  const agentIds = [...new Set(rows.map((r) => r.agent_id).filter(Boolean))];
  const appData = rows.map((r) => parseJsonSafe(r.data, {}));
  const candidateCodes = [
    ...new Set(
      rows.map(
        (r, idx) => normalizeAgentCode(
          r.sourced_agent_code || appData[idx]?.sourced_agent_code || appData[idx]?.sourcedAgentCode || appData[idx]?.agent_code || appData[idx]?.agentCode
        )
      ).filter(Boolean)
    )
  ];
  const agentCodeToUser = /* @__PURE__ */ new Map();
  if (candidateCodes.length) {
    const codeParams = {};
    const codePlaceholders = candidateCodes.map((code, i) => {
      codeParams[`code${i}`] = code;
      return `:code${i}`;
    });
    const [codeRows] = await pool.execute(
      `SELECT user_id, agent_code
       FROM agent_onboarding
       WHERE LOWER(TRIM(CAST(agent_code AS TEXT))) IN (${codePlaceholders.join(", ")})`,
      codeParams
    );
    for (const row of codeRows || []) {
      agentCodeToUser.set(normalizeAgentCode(row.agent_code), row.user_id);
      if (row.user_id) agentIds.push(row.user_id);
    }
  }
  const uniqueAgentIds = [...new Set(agentIds.filter(Boolean))];
  const hierarchyByAgent = /* @__PURE__ */ new Map();
  if (uniqueAgentIds.length) {
    const hParams = {};
    const hPlaceholders = uniqueAgentIds.map((id, i) => {
      hParams[`aid${i}`] = id;
      return `:aid${i}`;
    });
    const [hRows] = await pool.execute(
      `SELECT agent_user_id, employee_user_id, hierarchy_level, is_primary
       FROM agent_employee_hierarchy
       WHERE agent_user_id IN (${hPlaceholders.join(", ")})`,
      hParams
    );
    for (const row of hRows || []) {
      if (!hierarchyByAgent.has(row.agent_user_id)) hierarchyByAgent.set(row.agent_user_id, []);
      hierarchyByAgent.get(row.agent_user_id).push(row);
    }
  }
  const result = [];
  for (let i = 0; i < rows.length; i += 1) {
    const app = rows[i];
    const data = appData[i];
    const resolvedAgentId = app.agent_id || agentCodeToUser.get(
      normalizeAgentCode(
        app.sourced_agent_code || data?.sourced_agent_code || data?.sourcedAgentCode || data?.agent_code || data?.agentCode
      )
    ) || null;
    const ownerId = resolveResponsibleEmployeeIdForStage(
      app,
      resolvedAgentId ? hierarchyByAgent.get(resolvedAgentId) || [] : []
    );
    if (ownerId === employeeId || app.assigned_employee_id === employeeId) {
      result.push(app);
    }
  }
  return result;
}
portalDashboardsRouter.get("/agent/dashboard", authenticate, async (req, res, next) => {
  try {
    if (req.auth.role !== "agent" && !["admin", "super_admin"].includes(req.auth.role)) {
      const e = new Error("Agent access only");
      e.status = 403;
      throw e;
    }
    const pool = getPool();
    const agentId = req.auth.userId;
    await ensureAgentProfileSchema();
    const [[profile]] = await pool.execute(
      `SELECT up.*, ao.agent_code, ao.username
       FROM user_profiles up
       LEFT JOIN agent_onboarding ao ON ao.user_id = up.id
       WHERE up.id = :id LIMIT 1`,
      { id: agentId }
    );
    const agentCode = await ensureAgentCodeForUser(pool, agentId) || profile?.agent_code || null;
    const [apps] = await pool.execute(
      `SELECT la.*, c.full_name AS customer_full_name, c.email AS customer_email, c.phone AS customer_phone
       FROM loan_applications la
       LEFT JOIN user_profiles c ON c.id = la.customer_id
       WHERE la.agent_id = :agentId
          OR CAST(COALESCE(la.data->>'agent_id', '') AS TEXT) = CAST(:agentId AS TEXT)
          OR CAST(COALESCE(la.data->>'agentId', '') AS TEXT) = CAST(:agentId AS TEXT)
          OR (
            :agentCode IS NOT NULL
            AND (
              LOWER(TRIM(CAST(COALESCE(la.sourced_agent_code, '') AS TEXT))) = LOWER(TRIM(CAST(:agentCode AS TEXT)))
              OR LOWER(TRIM(CAST(COALESCE(la.data->>'sourced_agent_code', '') AS TEXT))) = LOWER(TRIM(CAST(:agentCode AS TEXT)))
              OR LOWER(TRIM(CAST(COALESCE(la.data->>'sourcedAgentCode', '') AS TEXT))) = LOWER(TRIM(CAST(:agentCode AS TEXT)))
              OR LOWER(TRIM(CAST(COALESCE(la.data->>'agent_code', '') AS TEXT))) = LOWER(TRIM(CAST(:agentCode AS TEXT)))
              OR LOWER(TRIM(CAST(COALESCE(la.data->>'agentCode', '') AS TEXT))) = LOWER(TRIM(CAST(:agentCode AS TEXT)))
            )
          )
       ORDER BY la.created_at DESC`,
      { agentId, agentCode }
    );
    const total = apps.length;
    const approved = apps.filter((a) => a.status === "approved").length;
    const conversionRate = total > 0 ? Math.round(approved / total * 100) : 0;
    await ensureStaffExtrasSchema();
    const { resolveAgentCommissionConfig } = await import("../lib/agentCommission.js");
    const commissionConfig = await resolveAgentCommissionConfig(pool, agentId);
    const commissionEntries = apps.map((row) => {
      const data = typeof row.data === "string" ? JSON.parse(row.data || "{}") : row.data || {};
      const amount = calculateCommissionFromApplication(
        { data: { ...data, requested_loan_amount: data.requested_loan_amount || data.requestedLoanAmount } },
        commissionConfig
      );
      return {
        id: row.id,
        clientName: row.customer_full_name || "Customer",
        loanType: data.loan_type_label || data.loan_type || data.loan_purpose || "Loan",
        productType: "loan",
        sourceType: "loan_application",
        amount,
        status: commissionStatusForApplication(row.status),
        applicationStatus: row.status,
        applicationNumber: row.application_number,
        sourcedAgentCode: row.sourced_agent_code,
        date: row.submitted_at || row.updated_at || row.created_at
      };
    });
    const ledgerRows = await fetchAgentCommissionLedger(pool, agentId);
    let insuranceOrders = [];
    let sipOrders = [];
    if (ledgerRows.length) {
      const insuranceIds = ledgerRows.filter((r) => r.source_type === "insurance_purchase").map((r) => r.source_id);
      const sipIds = ledgerRows.filter((r) => r.source_type === "mf_sip").map((r) => r.source_id);
      const fetchByIds = async (table, ids) => {
        if (!ids.length) return [];
        const params = {};
        const placeholders = ids.map((id, i) => {
          params[`id${i}`] = id;
          return `:id${i}`;
        });
        const [rows] = await pool.execute(
          `SELECT id, customer_name FROM ${table} WHERE id IN (${placeholders.join(",")})`,
          params
        );
        return rows || [];
      };
      insuranceOrders = await fetchByIds("insurance_purchase_orders", insuranceIds);
      sipOrders = await fetchByIds("mutual_fund_sip_orders", sipIds);
    }
    const ledgerEntries = ledgerRows.map(
      (row) => mapLedgerEntryToCommission(row, { insuranceOrders, sipOrders })
    );
    const allCommissionEntries = [...commissionEntries, ...ledgerEntries].sort(
      (a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()
    );
    const commissionEstimate = allCommissionEntries.filter((c) => c.status === "paid").reduce((sum, c) => sum + c.amount, 0);
    const pendingCommission = allCommissionEntries.filter((c) => c.status !== "paid").reduce((sum, c) => sum + c.amount, 0);
    const totalEstCommission = allCommissionEntries.reduce((sum, c) => sum + (c.amount || 0), 0);
    const commissionBreakdown = {
      loans: commissionEntries.reduce((sum, c) => sum + (c.amount || 0), 0),
      insurance: ledgerEntries.filter((c) => c.sourceType === "insurance_purchase").reduce((sum, c) => sum + (c.amount || 0), 0),
      sip: ledgerEntries.filter((c) => c.sourceType === "mf_sip").reduce((sum, c) => sum + (c.amount || 0), 0)
    };
    const trends = buildAgentMetricTrends(apps, allCommissionEntries);
    const performanceAnalytics = buildAgentPerformanceAnalytics(apps, allCommissionEntries);
    const circulars = await fetchAgentCommissionCirculars(pool).catch(() => []);
    let learningResources = [];
    try {
      learningResources = await getAgentLearningFeed(pool, agentId);
    } catch (err) {
      console.warn("[agent-dashboard] learning feed failed:", err?.message);
      learningResources = [];
    }
    let recentActivities = [];
    try {
      recentActivities = await buildAgentRecentActivities(pool, {
        agentId,
        agentCode,
        commissionConfig,
        limit: 15
      });
    } catch {
      recentActivities = [];
    }
    let attributedLeads = 0;
    let pipelineLeads = [];
    let attributedSipOrders = 0;
    if (agentCode) {
      try {
        const [[leadRow]] = await pool.execute(
          `SELECT COUNT(*)::int AS c FROM marketing_leads
           WHERE sourced_agent_code = :code`,
          { code: agentCode }
        );
        attributedLeads = Number(leadRow?.c || 0);
      } catch {
      }
      try {
        const [leadRows] = await pool.execute(
          `SELECT id, full_name, email, phone, loan_type, status, application_id, source, created_at, updated_at
           FROM marketing_leads
           WHERE sourced_agent_code = :code
           ORDER BY created_at DESC
           LIMIT 100`,
          { code: agentCode }
        );
        pipelineLeads = (leadRows || []).map(mapLeadToPipelineClient);
      } catch {
        pipelineLeads = [];
      }
      try {
        const [[sipRow]] = await pool.execute(
          `SELECT COUNT(*)::int AS c FROM mutual_fund_sip_orders
           WHERE sourced_agent_code = :code`,
          { code: agentCode }
        );
        attributedSipOrders = Number(sipRow?.c || 0);
      } catch {
      }
    }
    const referralBase = process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || "https://rfincare.com";
    const now = /* @__PURE__ */ new Date();
    const weekEnd = new Date(now);
    weekEnd.setHours(23, 59, 59, 999);
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - 6);
    weekStart.setHours(0, 0, 0, 0);
    const prevWeekEnd = new Date(weekStart);
    prevWeekEnd.setMilliseconds(-1);
    const prevWeekStart = new Date(prevWeekEnd);
    prevWeekStart.setDate(prevWeekStart.getDate() - 6);
    prevWeekStart.setHours(0, 0, 0, 0);
    const inWindow = (dateRaw, start, end) => {
      if (!dateRaw) return false;
      const d = new Date(dateRaw);
      return d >= start && d <= end;
    };
    const leadsThisWeek = pipelineLeads.filter((l) => inWindow(l.createdAt, weekStart, weekEnd)).length;
    const leadsPrevWeek = pipelineLeads.filter((l) => inWindow(l.createdAt, prevWeekStart, prevWeekEnd)).length;
    const appsThisWeek = apps.filter((a) => inWindow(a.created_at, weekStart, weekEnd)).length;
    const appsPrevWeek = apps.filter((a) => inWindow(a.created_at, prevWeekStart, prevWeekEnd)).length;
    const approvedThisWeek = apps.filter(
      (a) => inWindow(a.created_at, weekStart, weekEnd) && a.status === "approved"
    ).length;
    const approvedPrevWeek = apps.filter(
      (a) => inWindow(a.created_at, prevWeekStart, prevWeekEnd) && a.status === "approved"
    ).length;
    const pctChange = (cur, prev) => {
      if (prev === 0 && cur === 0) return "0%";
      if (prev === 0) return "+100%";
      const pct = Math.round((cur - prev) / prev * 100);
      return `${pct >= 0 ? "+" : ""}${pct}%`;
    };
    const totalCommAll = Math.max(totalEstCommission, 1);
    const creditCardEarnings = ledgerEntries.filter((c) => String(c.productType || c.sourceType || "").includes("credit")).reduce((sum, c) => sum + (c.amount || 0), 0);
    const othersEarnings = Math.max(
      0,
      totalEstCommission - commissionBreakdown.loans - commissionBreakdown.insurance - commissionBreakdown.sip - creditCardEarnings
    );
    const earningsByProduct = [
      { name: "Loans", value: commissionBreakdown.loans, color: "#1e3a5f" },
      { name: "Insurance", value: commissionBreakdown.insurance, color: "#059669" },
      { name: "Credit Cards", value: creditCardEarnings, color: "#2563eb" },
      { name: "Investments", value: commissionBreakdown.sip, color: "#7c3aed" },
      { name: "Others", value: othersEarnings, color: "#94a3b8" }
    ].filter((item) => item.value > 0).map((item) => ({
      ...item,
      pct: Math.round(item.value / totalCommAll * 1e3) / 10
    }));
    const productStats = {};
    for (const row of apps) {
      const data = typeof row.data === "string" ? JSON.parse(row.data || "{}") : row.data || {};
      const product = data.loan_type_label || data.loan_type || data.loanPurpose || "Other";
      if (!productStats[product]) {
        productStats[product] = { product, applications: 0, conversions: 0, earnings: 0 };
      }
      productStats[product].applications += 1;
      if (row.status === "approved") productStats[product].conversions += 1;
      const comm = allCommissionEntries.find((c) => c.id === row.id);
      productStats[product].earnings += comm?.amount || 0;
    }
    const topProducts = Object.values(productStats).sort((a, b) => b.earnings - a.earnings || b.applications - a.applications).slice(0, 5);
    const recentLeads = pipelineLeads.slice(0, 5).map((lead) => ({
      id: lead.id,
      name: lead.name,
      mobile: lead.phone || "—",
      product: lead.loanType || "—",
      source: lead.source || "Website",
      status: lead.rawStatus || lead.status,
      followUp: lead.followUpAt || lead.createdAt
    }));
    const paidEntries = allCommissionEntries.filter((c) => c.status === "paid");
    const lastPaid = paidEntries[0];
    const monthTarget = 15e4;
    const leadsChart = (performanceAnalytics.week || []).map((row) => ({
      name: row.name,
      leads: row.clients,
      applications: row.clients,
      conversions: row.conversions
    }));
    const earningsChart = (performanceAnalytics.week || []).map((row) => ({
      name: row.name,
      earnings: row.earnings
    }));
    res.json({
      profile: {
        name: profile?.full_name || "Agent",
        agentId: agentCode || "—",
        tier: profile?.is_active ? "Active Agent" : "Pending",
        totalClients: total,
        activeClients: apps.filter((a) => !["approved", "rejected"].includes(a.status)).length,
        avatarUrl: profile?.avatar_url || null
      },
      metrics: [
        {
          id: 1,
          type: "customers",
          label: "Active Clients",
          value: String(trends.activeClients),
          subtitle: `Total: ${total} clients`,
          trend: trends.clients.trend,
          change: trends.clients.change
        },
        {
          id: 2,
          type: "conversions",
          label: "Conversion Rate",
          value: `${conversionRate}%`,
          subtitle: `${approved} of ${total} approved`,
          trend: trends.conversions.trend,
          change: trends.conversions.change
        },
        {
          id: 3,
          type: "earnings",
          label: "Est. Commission",
          value: `₹${commissionEstimate.toLocaleString("en-IN")}`,
          subtitle: pendingCommission > 0 ? `₹${pendingCommission.toLocaleString("en-IN")} pending · ₹${totalEstCommission.toLocaleString("en-IN")} pipeline` : "Based on approvals",
          trend: trends.earnings.trend,
          change: trends.earnings.change
        },
        {
          id: 4,
          type: "satisfaction",
          label: "Status",
          value: profile?.is_active ? "Active" : "Inactive",
          subtitle: profile?.account_status || "",
          trend: "up",
          change: profile?.is_active ? "Live" : "Off"
        }
      ],
      clients: apps.map(mapAppToClient),
      applications: apps.map(mapAppToClient),
      pipelineLeads,
      commissions: commissionConfig ? [commissionConfig] : [],
      commissionEntries: allCommissionEntries,
      commissionSummary: {
        totalEarned: commissionEstimate,
        pending: pendingCommission,
        breakdown: commissionBreakdown
      },
      circulars,
      learningResources,
      recentActivities,
      performanceAnalytics,
      weeklyPerformance: performanceAnalytics.month,
      totalEarnings: commissionEstimate,
      pendingPayout: pendingCommission,
      overview: {
        totalLeads: Math.max(pipelineLeads.length, attributedLeads),
        totalApplications: total,
        approvedApplications: approved,
        totalEarnings: commissionEstimate,
        pendingPayout: pendingCommission,
        trends: {
          leads: pctChange(leadsThisWeek, leadsPrevWeek),
          applications: pctChange(appsThisWeek, appsPrevWeek),
          approved: pctChange(approvedThisWeek, approvedPrevWeek),
          earnings: trends.earnings.change
        },
        earningsByProduct,
        topProducts,
        recentLeads,
        leadsChart,
        earningsChart,
        achievement: {
          target: monthTarget,
          current: commissionEstimate,
          progress: Math.min(100, Math.round(commissionEstimate / monthTarget * 100)),
          tier: commissionEstimate >= 1e5 ? "Gold Partner" : commissionEstimate >= 5e4 ? "Silver Partner" : "Bronze Partner"
        },
        payoutSummary: {
          lastPayout: lastPaid?.amount || Math.round(commissionEstimate * 0.75) || 0,
          lastPayoutDate: lastPaid?.date || null,
          nextPayout: pendingCommission,
          nextPayoutDate: null
        }
      },
      attribution: {
        agentCode,
        attributedLeads,
        sipOrders: attributedSipOrders,
        shareLinks: agentCode ? {
          homepage: `${referralBase}/?agent=${encodeURIComponent(agentCode)}`,
          insurance: `${referralBase}/insurance-marketplace?agent=${encodeURIComponent(agentCode)}`,
          mutualFunds: `${referralBase}/mutual-fund-marketplace?agent=${encodeURIComponent(agentCode)}`,
          calculators: `${referralBase}/resources/calculators?agent=${encodeURIComponent(agentCode)}`
        } : null
      }
    });
  } catch (err) {
    next(err);
  }
});
portalDashboardsRouter.get("/employee/access", authenticate, async (req, res, next) => {
  try {
    if (req.auth.role !== "employee") {
      const e = new Error("Employee access only");
      e.status = 403;
      throw e;
    }
    const access = await getEffectiveEmployeeAccess(req.auth.userId);
    res.json({ access });
  } catch (err) {
    next(err);
  }
});
portalDashboardsRouter.get("/employee/dashboard", authenticate, async (req, res, next) => {
  try {
    if (!["employee", "admin", "super_admin"].includes(req.auth.role)) {
      const e = new Error("Employee access only");
      e.status = 403;
      throw e;
    }
    const pool = getPool();
    const employeeId = req.auth.userId;
    await ensureAgentLearningSchema();
    const [rawApps] = await pool.execute(
      `SELECT la.*, c.full_name AS customer_full_name
       FROM loan_applications la
       LEFT JOIN user_profiles c ON c.id = la.customer_id
       WHERE la.assigned_employee_id = :id
          OR EXISTS (
            SELECT 1
            FROM agent_employee_hierarchy h
            LEFT JOIN agent_onboarding ao ON ao.user_id = h.agent_user_id
            WHERE h.employee_user_id = :id
              AND (
                h.agent_user_id = la.agent_id
                OR LOWER(TRIM(CAST(COALESCE(la.sourced_agent_code, '') AS TEXT))) = LOWER(TRIM(CAST(COALESCE(ao.agent_code, '') AS TEXT)))
                OR LOWER(TRIM(CAST(COALESCE(la.data->>'sourced_agent_code', '') AS TEXT))) = LOWER(TRIM(CAST(COALESCE(ao.agent_code, '') AS TEXT)))
                OR LOWER(TRIM(CAST(COALESCE(la.data->>'sourcedAgentCode', '') AS TEXT))) = LOWER(TRIM(CAST(COALESCE(ao.agent_code, '') AS TEXT)))
                OR LOWER(TRIM(CAST(COALESCE(la.data->>'agent_code', '') AS TEXT))) = LOWER(TRIM(CAST(COALESCE(ao.agent_code, '') AS TEXT)))
                OR LOWER(TRIM(CAST(COALESCE(la.data->>'agentCode', '') AS TEXT))) = LOWER(TRIM(CAST(COALESCE(ao.agent_code, '') AS TEXT)))
              )
          )
       ORDER BY la.created_at DESC`,
      { id: employeeId }
    );
    const apps = await filterApplicationsForEmployeeByHierarchy(pool, employeeId, rawApps);
    const [[pendingDocs]] = await pool.execute(
      `SELECT COUNT(*) AS c FROM customer_documents cd
       WHERE COALESCE(cd.verification_status, cd.status, 'pending') IN ('pending','uploaded')`
    );
    const [activities] = await pool.execute(
      `SELECT action_type, table_name, record_id, created_at
       FROM audit_logs WHERE user_id = :id ORDER BY created_at DESC LIMIT 20`,
      { id: employeeId }
    );
    const learningResources = await getEmployeeLearningFeed(pool, employeeId);
    const access = await getEffectiveEmployeeAccess(employeeId);
    const canApplications = employeeHasModulePermission(access, "applications", "read");
    const canDocuments = employeeHasModulePermission(access, "documents", "read");
    const canReports = employeeHasModulePermission(access, "reports", "read");
    res.json({
      access,
      stats: {
        assignedApplications: canApplications ? apps.length : 0,
        pendingReview: canApplications ? apps.filter((a) => ["submitted", "pending", "under_review"].includes(a.status)).length : 0,
        pendingDocuments: canDocuments ? Number(pendingDocs?.c || 0) : 0,
        completedToday: canApplications ? apps.filter((a) => {
          if (!a.reviewed_at) return false;
          const d = new Date(a.reviewed_at);
          const today = /* @__PURE__ */ new Date();
          return d.toDateString() === today.toDateString();
        }).length : 0
      },
      learningResources,
      applications: canApplications ? apps.map((row) => {
        const data = typeof row.data === "string" ? (() => {
          try {
            return JSON.parse(row.data || "{}");
          } catch {
            return {};
          }
        })() : row.data || {};
        return {
          ...mapAppToClient(row),
          id: row.id,
          customerName: row.customer_full_name,
          customer: row.customer_id ? { id: row.customer_id, fullName: row.customer_full_name } : null,
          status: row.status,
          applicationNumber: row.application_number,
          submittedAt: row.submitted_at,
          createdAt: row.created_at,
          loanAmount: data.loan_amount ?? data.requested_loan_amount ?? null,
          loanTypeLabel: data.loan_type_label || data.loan_type || data.loan_purpose,
          loanPurpose: data.loan_purpose || data.loan_type_label,
          data
        };
      }) : [],
      activities: canReports ? activities.map((a) => ({
        id: `${a.record_id}-${a.created_at}`,
        type: String(a.action_type).toLowerCase(),
        actionType: `${a.action_type} · ${a.table_name}`,
        timestamp: new Date(a.created_at).toLocaleString(),
        details: a.record_id
      })) : []
    });
  } catch (err) {
    next(err);
  }
});
export {
  portalDashboardsRouter
};
