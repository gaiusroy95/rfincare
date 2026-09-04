const DEFAULT_PRODUCT_BUCKETS = [
  { key: "personal_loan", label: "Personal Loan" },
  { key: "home_loan", label: "Home Loan" },
  { key: "business_loan", label: "Business Loan" },
  { key: "auto_loan", label: "Auto Loan" },
  { key: "education_loan", label: "Education Loan" },
  { key: "credit_card", label: "Credit Card" },
  { key: "insurance", label: "Insurance" },
  { key: "mutual_funds", label: "Mutual Funds" },
  { key: "fixed_income", label: "Fixed Income" },
  { key: "post_office", label: "Post Office" },
  { key: "government_schemes", label: "Government Schemes" }
];
function normalizeProductKey(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (!raw) return "other";
  if (raw.includes("personal")) return "personal_loan";
  if (raw.includes("home")) return "home_loan";
  if (raw.includes("business")) return "business_loan";
  if (raw.includes("auto") || raw.includes("car")) return "auto_loan";
  if (raw.includes("education") || raw.includes("student")) return "education_loan";
  if (raw.includes("credit")) return "credit_card";
  if (raw.includes("insurance")) return "insurance";
  if (raw.includes("mutual") || raw.includes("sip")) return "mutual_funds";
  if (raw.includes("fixed")) return "fixed_income";
  if (raw.includes("post_office") || raw.includes("postoffice")) return "post_office";
  if (raw.includes("government") || raw.includes("scheme")) return "government_schemes";
  return raw;
}
function titleizeKey(key) {
  return String(key || "Other").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function buildDateWindow({ days = 30, dateFrom, dateTo } = {}) {
  if (dateFrom || dateTo) {
    const from = dateFrom ? /* @__PURE__ */ new Date(`${dateFrom}T00:00:00.000Z`) : null;
    const to = dateTo ? /* @__PURE__ */ new Date(`${dateTo}T00:00:00.000Z`) : null;
    if (to) to.setUTCDate(to.getUTCDate() + 1);
    return {
      fromIso: from && !Number.isNaN(from.getTime()) ? from.toISOString() : null,
      toIso: to && !Number.isNaN(to.getTime()) ? to.toISOString() : null,
      windowDays: null,
      label: `${dateFrom || "start"} to ${dateTo || "today"}`
    };
  }
  const windowDays = Math.min(365, Math.max(7, Number(days) || 30));
  return { fromIso: null, toIso: null, windowDays, label: `Last ${windowDays} days` };
}
function buildRangeFilter(alias, window) {
  if (window.windowDays != null) {
    return {
      sql: `${alias}.created_at >= NOW() - make_interval(days => :days)`,
      params: { days: window.windowDays }
    };
  }
  const parts = [];
  const params = {};
  if (window.fromIso) {
    parts.push(`${alias}.created_at >= :fromIso`);
    params.fromIso = window.fromIso;
  }
  if (window.toIso) {
    parts.push(`${alias}.created_at < :toIso`);
    params.toIso = window.toIso;
  }
  return { sql: parts.length ? parts.join(" AND ") : "1=1", params };
}
function initBucket(label) {
  return {
    productLabel: label,
    leadsCreated: 0,
    conversions: 0,
    payoutAmount: 0,
    createdByAgent: 0,
    createdByEmployee: 0,
    convertedByAgent: 0,
    convertedByEmployee: 0,
    conversionsRows: []
  };
}
function toNumber(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}
function pushConversionRow(bucket, row) {
  bucket.conversions += 1;
  bucket.payoutAmount += toNumber(row.payoutAmount);
  if (row.convertedByRole === "agent") bucket.convertedByAgent += 1;
  if (row.convertedByRole === "employee") bucket.convertedByEmployee += 1;
  bucket.conversionsRows.push(row);
}
function buildBucketsMap() {
  const map = /* @__PURE__ */ new Map();
  for (const item of DEFAULT_PRODUCT_BUCKETS) {
    map.set(item.key, initBucket(item.label));
  }
  return map;
}
function getBucket(map, key) {
  const normalized = normalizeProductKey(key);
  if (!map.has(normalized)) {
    map.set(normalized, initBucket(titleizeKey(normalized)));
  }
  return { key: normalized, bucket: map.get(normalized) };
}
async function buildFunnelAnalytics(pool, { days = 30, dateFrom, dateTo } = {}) {
  const window = buildDateWindow({ days, dateFrom, dateTo });
  const leadsRange = buildRangeFilter("ml", window);
  const appsRange = buildRangeFilter("la", window);
  const insuranceRange = buildRangeFilter("ipo", window);
  const sipRange = buildRangeFilter("mso", window);
  const bucketMap = buildBucketsMap();
  const [leadRows] = await pool.execute(
    `SELECT
       ml.id,
       ml.loan_type,
       ml.status,
       ml.created_at,
       ml.sourced_agent_code,
       ml.assigned_to,
       ass.role AS assigned_role,
       ass.full_name AS assigned_name
     FROM marketing_leads ml
     LEFT JOIN user_profiles ass ON ass.id = ml.assigned_to
     WHERE ${leadsRange.sql}`,
    leadsRange.params
  );
  for (const lead of leadRows || []) {
    const { bucket } = getBucket(bucketMap, lead.loan_type);
    bucket.leadsCreated += 1;
    if (lead.sourced_agent_code) bucket.createdByAgent += 1;
    else if (lead.assigned_role === "employee") bucket.createdByEmployee += 1;
  }
  const [loanRows] = await pool.execute(
    `SELECT
       la.id,
       la.application_number,
       COALESCE(
         NULLIF(TRIM(CAST(la.data->>'loan_type_label' AS TEXT)), ''),
         NULLIF(TRIM(CAST(la.data->>'loan_type' AS TEXT)), ''),
         NULLIF(TRIM(CAST(la.data->>'loanType' AS TEXT)), ''),
         NULLIF(TRIM(CAST(la.data->>'loan_purpose' AS TEXT)), ''),
         NULLIF(TRIM(CAST(la.data->>'loanPurpose' AS TEXT)), ''),
         'personal_loan'
       ) AS loan_type,
       la.status,
       la.created_at,
       la.reviewed_at,
       la.net_payout,
       la.commission_amount,
       la.sourced_agent_code,
       la.agent_id,
       la.assigned_employee_id,
       ag.full_name AS agent_name,
       ag.email AS agent_email,
       em.full_name AS employee_name,
       em.email AS employee_email,
       ml.id AS lead_id,
       ml.sourced_agent_code AS lead_sourced_agent_code,
       ml.assigned_to AS lead_assigned_to
     FROM loan_applications la
     LEFT JOIN user_profiles ag ON ag.id = la.agent_id
     LEFT JOIN user_profiles em ON em.id = la.assigned_employee_id
     LEFT JOIN marketing_leads ml ON ml.application_id = la.id
     WHERE ${appsRange.sql}`,
    appsRange.params
  );
  const loanAppsTotal = (loanRows || []).length;
  let loanApproved = 0;
  let loanInReview = 0;
  let loanDraft = 0;
  let loanRejected = 0;
  let agentAttributedLoan = 0;
  for (const app of loanRows || []) {
    const s = String(app.status || "").toLowerCase();
    if (s === "approved") loanApproved += 1;
    else if (s === "draft") loanDraft += 1;
    else if (s === "rejected") loanRejected += 1;
    else loanInReview += 1;
    if (app.sourced_agent_code) agentAttributedLoan += 1;
    if (s !== "approved") continue;
    const { key, bucket } = getBucket(bucketMap, app.loan_type);
    const createdByRole = app.lead_sourced_agent_code ? "agent" : app.lead_assigned_to ? "employee" : "system";
    const convertedByRole = app.agent_id || app.sourced_agent_code ? "agent" : app.assigned_employee_id ? "employee" : "system";
    const payoutAmount = toNumber(app.net_payout) || toNumber(app.commission_amount);
    pushConversionRow(bucket, {
      channel: "loan_application",
      referenceId: app.id,
      referenceNumber: app.application_number,
      createdAt: app.created_at,
      convertedAt: app.reviewed_at || app.created_at,
      createdByRole,
      createdByName: createdByRole === "agent" ? app.agent_name || app.sourced_agent_code || "Agent" : app.employee_name || "System",
      convertedByRole,
      convertedByName: convertedByRole === "agent" ? app.agent_name || app.sourced_agent_code || "Agent" : app.employee_name || "System",
      payoutAmount,
      payoutOwnerRole: convertedByRole,
      payoutOwnerName: convertedByRole === "agent" ? app.agent_name || app.sourced_agent_code || "Agent" : app.employee_name || "System",
      productKey: key,
      productLabel: bucket.productLabel,
      saleStatus: "approved"
    });
  }
  let insuranceRows = [];
  try {
    const [rows] = await pool.execute(
      `SELECT
         ipo.id,
         ipo.customer_name,
         ipo.created_at,
         ipo.paid_at,
         ipo.payment_status,
         ipo.sourced_agent_code,
         ip.name AS product_name,
         ao.user_id AS agent_user_id,
         ag.full_name AS agent_name,
         ledger.commission_amount
       FROM insurance_purchase_orders ipo
       LEFT JOIN insurance_products ip ON ip.id = ipo.insurance_product_id
       LEFT JOIN agent_onboarding ao ON ao.agent_code = ipo.sourced_agent_code
       LEFT JOIN user_profiles ag ON ag.id = ao.user_id
       LEFT JOIN agent_commission_ledger ledger
         ON ledger.source_type = 'insurance_purchase' AND ledger.source_id = ipo.id
       WHERE ${insuranceRange.sql}`,
      insuranceRange.params
    );
    insuranceRows = rows || [];
  } catch {
    insuranceRows = [];
  }
  let insuranceStarted = 0;
  let insurancePaid = 0;
  let insurancePaidAgent = 0;
  for (const row of insuranceRows) {
    insuranceStarted += 1;
    if (String(row.payment_status || "").toLowerCase() !== "paid") continue;
    insurancePaid += 1;
    if (row.sourced_agent_code) insurancePaidAgent += 1;
    const { key, bucket } = getBucket(bucketMap, row.product_name || "insurance");
    const convertedByRole = row.sourced_agent_code ? "agent" : "system";
    pushConversionRow(bucket, {
      channel: "insurance_purchase",
      referenceId: row.id,
      referenceNumber: row.id,
      createdAt: row.created_at,
      convertedAt: row.paid_at || row.created_at,
      createdByRole: row.sourced_agent_code ? "agent" : "system",
      createdByName: row.agent_name || row.sourced_agent_code || "System",
      convertedByRole,
      convertedByName: row.agent_name || row.sourced_agent_code || "System",
      payoutAmount: toNumber(row.commission_amount),
      payoutOwnerRole: convertedByRole,
      payoutOwnerName: row.agent_name || row.sourced_agent_code || "System",
      productKey: key,
      productLabel: bucket.productLabel,
      saleStatus: "paid"
    });
  }
  let sipRows = [];
  try {
    const [rows] = await pool.execute(
      `SELECT
         mso.id,
         mso.created_at,
         mso.status,
         mso.sourced_agent_code,
         mf.name AS fund_name,
         ao.user_id AS agent_user_id,
         ag.full_name AS agent_name,
         ledger.commission_amount
       FROM mutual_fund_sip_orders mso
       LEFT JOIN mutual_funds mf ON mf.id = mso.mutual_fund_id
       LEFT JOIN agent_onboarding ao ON ao.agent_code = mso.sourced_agent_code
       LEFT JOIN user_profiles ag ON ag.id = ao.user_id
       LEFT JOIN agent_commission_ledger ledger
         ON ledger.source_type = 'mf_sip' AND ledger.source_id = mso.id
       WHERE ${sipRange.sql}`,
      sipRange.params
    );
    sipRows = rows || [];
  } catch {
    sipRows = [];
  }
  let sipStarted = 0;
  let sipActive = 0;
  let sipActiveAgent = 0;
  for (const row of sipRows) {
    sipStarted += 1;
    const active = ["active", "mandate_pending"].includes(String(row.status || "").toLowerCase());
    if (!active) continue;
    sipActive += 1;
    if (row.sourced_agent_code) sipActiveAgent += 1;
    const { key, bucket } = getBucket(bucketMap, row.fund_name || "mutual_funds");
    const convertedByRole = row.sourced_agent_code ? "agent" : "system";
    pushConversionRow(bucket, {
      channel: "mutual_fund_sip",
      referenceId: row.id,
      referenceNumber: row.id,
      createdAt: row.created_at,
      convertedAt: row.created_at,
      createdByRole: row.sourced_agent_code ? "agent" : "system",
      createdByName: row.agent_name || row.sourced_agent_code || "System",
      convertedByRole,
      convertedByName: row.agent_name || row.sourced_agent_code || "System",
      payoutAmount: toNumber(row.commission_amount),
      payoutOwnerRole: convertedByRole,
      payoutOwnerName: row.agent_name || row.sourced_agent_code || "System",
      productKey: key,
      productLabel: bucket.productLabel,
      saleStatus: String(row.status || "").toLowerCase()
    });
  }
  let topAgents = [];
  try {
    const [rows] = await pool.execute(
      `SELECT sourced_agent_code AS agent_code, COUNT(*)::int AS lead_count
       FROM marketing_leads ml
       WHERE ${leadsRange.sql}
         AND sourced_agent_code IS NOT NULL AND sourced_agent_code != ''
       GROUP BY sourced_agent_code
       ORDER BY lead_count DESC
       LIMIT 10`,
      leadsRange.params
    );
    topAgents = (rows || []).map((r) => ({
      agentCode: r.agent_code,
      leadCount: Number(r.lead_count || 0)
    }));
  } catch {
    topAgents = [];
  }
  const productBuckets = Array.from(bucketMap.entries()).map(([productKey, bucket]) => ({
    productKey,
    ...bucket,
    payoutAmount: Number(bucket.payoutAmount.toFixed(2))
  })).sort((a, b) => b.conversions - a.conversions || b.leadsCreated - a.leadsCreated);
  const leadsTotal = (leadRows || []).length;
  const profileComplete = (leadRows || []).filter((r) => String(r.status || "") === "profile_complete").length;
  const assigned = (leadRows || []).filter((r) => String(r.status || "") === "assigned").length;
  const convertedLeads = (leadRows || []).filter((r) => String(r.status || "") === "converted").length;
  const agentAttributedLeads = (leadRows || []).filter((r) => !!r.sourced_agent_code).length;
  const funnels = [
    {
      id: "marketplace",
      label: "Marketplace leads",
      stages: [
        { key: "leads", label: "Enquiries", count: leadsTotal },
        { key: "profile", label: "Profile complete", count: profileComplete },
        { key: "assigned", label: "Assigned to staff", count: assigned }
      ]
    },
    {
      id: "loans",
      label: "Loan applications",
      stages: [
        { key: "draft", label: "Draft", count: loanDraft },
        { key: "submitted", label: "Submitted / review", count: loanInReview },
        { key: "approved", label: "Approved", count: loanApproved }
      ]
    },
    {
      id: "insurance",
      label: "Insurance purchase",
      stages: [
        { key: "checkout", label: "Checkout started", count: insuranceStarted },
        { key: "paid", label: "Paid", count: insurancePaid }
      ]
    },
    {
      id: "mutual_funds",
      label: "Mutual fund SIP",
      stages: [
        { key: "sip", label: "SIP started", count: sipStarted },
        { key: "mandate_active", label: "Mandate / active", count: sipActive }
      ]
    },
    {
      id: "agent_attribution",
      label: "Agent attribution",
      stages: [
        { key: "agent_leads", label: "Agent-attributed leads", count: agentAttributedLeads },
        { key: "agent_loans", label: "Agent-attributed loans", count: agentAttributedLoan },
        { key: "insurance_paid", label: "Insurance paid (agent)", count: insurancePaidAgent },
        { key: "sip_mandate_active", label: "SIP active (agent)", count: sipActiveAgent }
      ]
    },
    {
      id: "employee_leads",
      label: "Employee lead handling",
      stages: [
        { key: "assigned", label: "Assigned to staff", count: assigned },
        { key: "converted", label: "Converted", count: convertedLeads }
      ]
    }
  ];
  const productMix = productBuckets.map((b) => ({ label: b.productLabel, count: b.leadsCreated + b.conversions })).filter((i) => i.count > 0).sort((a, b) => b.count - a.count);
  const conversionRates = {
    leadToProfile: leadsTotal > 0 ? Math.round(profileComplete / leadsTotal * 100) : 0,
    loanApproval: loanAppsTotal > 0 ? Math.round(loanApproved / loanAppsTotal * 100) : 0,
    insurancePayment: insuranceStarted > 0 ? Math.round(insurancePaid / insuranceStarted * 100) : 0
  };
  return {
    windowDays: window.windowDays,
    windowLabel: window.label,
    dateFrom: window.fromIso ? window.fromIso.slice(0, 10) : null,
    dateTo: window.toIso ? new Date(new Date(window.toIso).getTime() - 1).toISOString().slice(0, 10) : null,
    funnels,
    productMix,
    productBuckets,
    topAgents,
    conversionRates,
    totals: {
      leads: leadsTotal,
      loanApplications: loanAppsTotal,
      insuranceCheckouts: insuranceStarted,
      insurancePaid,
      insurancePaidAgent,
      sipOrders: sipStarted,
      sipActive,
      sipActiveAgent,
      agentAttributedLeads,
      employeeAssignedLeads: assigned,
      employeeConvertedLeads: convertedLeads
    }
  };
}
async function buildProductConversionRows(pool, options = {}) {
  const data = await buildFunnelAnalytics(pool, options);
  const key = normalizeProductKey(options.productKey || "");
  const bucket = (data.productBuckets || []).find((b) => normalizeProductKey(b.productKey) === key);
  return {
    productKey: key,
    productLabel: bucket?.productLabel || titleizeKey(key),
    rows: bucket?.conversionsRows || []
  };
}
export {
  buildFunnelAnalytics,
  buildProductConversionRows
};
