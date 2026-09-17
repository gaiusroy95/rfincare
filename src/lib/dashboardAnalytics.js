import { getPool, isNoSuchTableError, isBadFieldError } from '../db/pool.js';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Calendar month (local) → inclusive YYYY-MM-DD bounds. */
export function resolveDashboardPeriod({ year, month, from, to } = {}) {
  const now = new Date();
  let y = Number(year);
  let m = Number(month);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    if (from && to) {
      const start = new Date(`${String(from).slice(0, 10)}T00:00:00`);
      if (!Number.isNaN(start.getTime())) {
        return {
          year: start.getFullYear(),
          month: start.getMonth() + 1,
          startDate: String(from).slice(0, 10),
          endDate: String(to).slice(0, 10),
        };
      }
    }
    y = now.getFullYear();
    m = now.getMonth() + 1;
  }
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 0);
  return {
    year: y,
    month: m,
    startDate: `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`,
    endDate: `${end.getFullYear()}-${pad2(end.getMonth() + 1)}-${pad2(end.getDate())}`,
  };
}

export function formatInr(amount) {
  const n = Number(amount || 0);
  if (!Number.isFinite(n)) return '₹0';
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

async function safeScalar(pool, sql, params = {}) {
  try {
    const [[row]] = await pool.execute(sql, params);
    return row || {};
  } catch (err) {
    if (isNoSuchTableError(err) || isBadFieldError(err)) return {};
    throw err;
  }
}

async function safeRows(pool, sql, params = {}) {
  try {
    const [rows] = await pool.execute(sql, params);
    return rows || [];
  } catch (err) {
    if (isNoSuchTableError(err) || isBadFieldError(err)) return [];
    throw err;
  }
}

const DATE_BETWEEN = (column) =>
  `${column}::date BETWEEN :start::date AND :end::date`;

/**
 * Live admin dashboard analytics for a calendar month (synced from system tables).
 */
export async function buildDashboardAnalytics(pool = getPool(), periodInput = {}) {
  const period = resolveDashboardPeriod(periodInput);
  const params = {
    start: period.startDate,
    end: period.endDate,
  };

  const users = await safeScalar(
    pool,
    `SELECT COUNT(*)::int AS total
     FROM user_profiles
     WHERE ${DATE_BETWEEN('created_at')}`,
    params,
  );

  const apps = await safeScalar(
    pool,
    `SELECT
       COUNT(*)::int AS total,
       SUM(CASE WHEN LOWER(COALESCE(status, '')) IN ('submitted', 'pending', 'under_review', 'documents_pending') THEN 1 ELSE 0 END)::int AS pending,
       SUM(CASE WHEN LOWER(COALESCE(status, '')) IN ('approved', 'disbursed') THEN 1 ELSE 0 END)::int AS approved,
       COALESCE(SUM(
         CASE
           WHEN LOWER(COALESCE(status, '')) = 'disbursed'
             OR disbursed_amount IS NOT NULL
           THEN COALESCE(disbursed_amount, loan_amount, 0)
           ELSE 0
         END
       ), 0)::float AS disbursed,
       COALESCE(SUM(
         CASE
           WHEN LOWER(COALESCE(loan_type, '')) IN ('post_office', 'fixed_income', 'investment', 'mutual_fund', 'sip')
             OR LOWER(COALESCE(loan_type, '')) LIKE '%invest%'
           THEN COALESCE(loan_amount, disbursed_amount, 0)
           ELSE 0
         END
       ), 0)::float AS investments
     FROM loan_applications
     WHERE ${DATE_BETWEEN('created_at')}`,
    params,
  );

  const disbursedWindow = await safeScalar(
    pool,
    `SELECT COALESCE(SUM(COALESCE(disbursed_amount, loan_amount, 0)), 0)::float AS disbursed
     FROM loan_applications
     WHERE LOWER(COALESCE(status, '')) = 'disbursed'
       AND COALESCE(disbursed_at, updated_at, created_at)::date BETWEEN :start::date AND :end::date`,
    params,
  );

  const premium = await safeScalar(
    pool,
    `SELECT COALESCE(SUM(payment_amount), 0)::float AS total
     FROM insurance_purchase_orders
     WHERE COALESCE(paid_at, created_at)::date BETWEEN :start::date AND :end::date
       AND LOWER(COALESCE(payment_status, '')) IN ('paid', 'captured', 'success', 'completed')`,
    params,
  );

  const premiumFallback = await safeScalar(
    pool,
    `SELECT COALESCE(SUM(payment_amount), 0)::float AS total
     FROM insurance_purchase_orders
     WHERE ${DATE_BETWEEN('created_at')}`,
    params,
  );

  const commission = await safeScalar(
    pool,
    `SELECT COALESCE(SUM(commission_amount), 0)::float AS total
     FROM agent_commission_ledger
     WHERE ${DATE_BETWEEN('created_at')}`,
    params,
  );

  const byType = await safeRows(
    pool,
    `SELECT COALESCE(NULLIF(TRIM(loan_type), ''), 'Other') AS name, COUNT(*)::int AS value
     FROM loan_applications
     WHERE ${DATE_BETWEEN('created_at')}
     GROUP BY 1
     ORDER BY value DESC
     LIMIT 8`,
    params,
  );

  const recent = await safeRows(
    pool,
    `SELECT la.id, la.application_number, la.loan_type, la.status, la.loan_amount, la.created_at,
            c.full_name AS customer_name
     FROM loan_applications la
     LEFT JOIN user_profiles c ON c.id = la.customer_id
     WHERE la.created_at::date BETWEEN :start::date AND :end::date
     ORDER BY la.created_at DESC
     LIMIT 8`,
    params,
  );

  const revenueSeries = [];
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(period.year, period.month - 1 - i, 1);
    const s = new Date(d.getFullYear(), d.getMonth(), 1);
    const e = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const p = {
      start: `${s.getFullYear()}-${pad2(s.getMonth() + 1)}-01`,
      end: `${e.getFullYear()}-${pad2(e.getMonth() + 1)}-${pad2(e.getDate())}`,
    };
    const loanRev = await safeScalar(
      pool,
      `SELECT COALESCE(SUM(COALESCE(disbursed_amount, loan_amount, 0)), 0)::float AS total
       FROM loan_applications
       WHERE LOWER(COALESCE(status, '')) IN ('approved', 'disbursed')
         AND created_at::date BETWEEN :start::date AND :end::date`,
      p,
    );
    const premRev = await safeScalar(
      pool,
      `SELECT COALESCE(SUM(payment_amount), 0)::float AS total
       FROM insurance_purchase_orders
       WHERE created_at::date BETWEEN :start::date AND :end::date`,
      p,
    );
    const total = Number(loanRev.total || 0) + Number(premRev.total || 0);
    revenueSeries.push({
      month: d.toLocaleDateString('en-IN', { month: 'short' }),
      year: d.getFullYear(),
      revenue: Number((total / 1e7).toFixed(2)),
      revenueRaw: total,
    });
  }

  const pendingAgents = await safeScalar(
    pool,
    `SELECT COUNT(*)::int AS total
     FROM agent_onboarding
     WHERE LOWER(COALESCE(onboarding_status, '')) IN ('pending', 'pending_qc', 'submitted', 'under_review')
        OR LOWER(COALESCE(qc_status, '')) IN ('pending_qc', 'pending')`,
  );

  const employees = await safeScalar(
    pool,
    `SELECT COUNT(*)::int AS total FROM user_profiles WHERE role = 'employee' AND COALESCE(is_active, TRUE) = TRUE`,
  );

  const matrixRules = await safeScalar(
    pool,
    `SELECT COUNT(*)::int AS total FROM approval_matrix_rules WHERE is_active = TRUE`,
  );

  const activity = await safeRows(
    pool,
    `SELECT action_type, table_name, created_at, user_id
     FROM audit_logs
     WHERE created_at::date BETWEEN :start::date AND :end::date
     ORDER BY created_at DESC
     LIMIT 8`,
    params,
  );

  const disbursedRaw = Number(disbursedWindow.disbursed || apps.disbursed || 0);
  const premiumRaw = Number(premium.total || 0) || Number(premiumFallback.total || 0);
  const investmentsRaw = Number(apps.investments || 0);
  const commissionRaw = Number(commission.total || 0);
  const revenueRaw = disbursedRaw + premiumRaw + commissionRaw;

  const monthName = new Date(period.year, period.month - 1, 1).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  });
  const labelFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  const periodLabel = `${labelFmt.format(new Date(`${period.startDate}T00:00:00`))} – ${labelFmt.format(new Date(`${period.endDate}T00:00:00`))}`;

  return {
    period: {
      ...period,
      monthLabel: monthName,
      label: periodLabel,
    },
    kpis: {
      totalUsers: Number(users.total || 0),
      totalApplications: Number(apps.total || 0),
      pendingReviews: Number(apps.pending || 0),
      approvedApplications: Number(apps.approved || 0),
      totalDisbursed: formatInr(disbursedRaw),
      totalDisbursedRaw: disbursedRaw,
      totalPremium: formatInr(premiumRaw),
      totalPremiumRaw: premiumRaw,
      totalInvestments: formatInr(investmentsRaw),
      totalInvestmentsRaw: investmentsRaw,
      totalRevenue: formatInr(revenueRaw),
      totalRevenueRaw: revenueRaw,
    },
    applicationsByType: byType.map((r) => ({ name: r.name, value: Number(r.value || 0) })),
    recentApplications: recent.map((r) => ({
      id: r.id,
      applicationNumber: r.application_number,
      loanType: r.loan_type,
      status: r.status,
      amount: Number(r.loan_amount || 0),
      customerName: r.customer_name,
      createdAt: r.created_at,
    })),
    revenueSeries,
    quickActionCounts: {
      pendingApprovals: Number(apps.pending || 0),
      pendingAgents: Number(pendingAgents.total || 0),
      employees: Number(employees.total || 0),
      matrixRules: Number(matrixRules.total || 0),
    },
    activity: activity.map((a) => ({
      action: `${String(a.action_type || 'update').replace(/_/g, ' ')} on ${a.table_name || 'record'}`,
      createdAt: a.created_at,
    })),
  };
}
