/**
 * Conversion funnel metrics for admin analytics.
 */

export async function buildFunnelAnalytics(pool, { days = 30 } = {}) {
  const windowDays = Math.min(365, Math.max(7, Number(days) || 30));

  const [[leadStats]] = await pool.execute(
    `SELECT
       COUNT(*)::int AS total,
       SUM(CASE WHEN loan_type = 'insurance' THEN 1 ELSE 0 END)::int AS insurance,
       SUM(CASE WHEN loan_type = 'mutual_funds' THEN 1 ELSE 0 END)::int AS mutual_funds,
       SUM(CASE WHEN status IN ('new', 'verified') THEN 1 ELSE 0 END)::int AS early_stage,
       SUM(CASE WHEN status = 'profile_complete' THEN 1 ELSE 0 END)::int AS profile_complete,
       SUM(CASE WHEN status = 'assigned' THEN 1 ELSE 0 END)::int AS assigned,
       SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END)::int AS converted,
       SUM(CASE WHEN sourced_agent_code IS NOT NULL AND sourced_agent_code != '' THEN 1 ELSE 0 END)::int AS agent_attributed
     FROM marketing_leads
     WHERE created_at >= NOW() - make_interval(days => :days)`,
    { days: windowDays },
  );

  const [[appStats]] = await pool.execute(
    `SELECT
       COUNT(*)::int AS total,
       SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END)::int AS draft,
       SUM(CASE WHEN status IN ('submitted', 'pending', 'under_review') THEN 1 ELSE 0 END)::int AS in_review,
       SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END)::int AS approved,
       SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END)::int AS rejected,
       SUM(CASE WHEN sourced_agent_code IS NOT NULL AND sourced_agent_code != '' THEN 1 ELSE 0 END)::int AS agent_attributed
     FROM loan_applications
     WHERE created_at >= NOW() - make_interval(days => :days)`,
    { days: windowDays },
  );

  let insuranceCheckout = { started: 0, paid: 0, agentPaid: 0 };
  try {
    const [[row]] = await pool.execute(
      `SELECT
         COUNT(*)::int AS started,
         SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END)::int AS paid,
         SUM(CASE WHEN payment_status = 'paid' AND sourced_agent_code IS NOT NULL AND sourced_agent_code != '' THEN 1 ELSE 0 END)::int AS agent_paid
       FROM insurance_purchase_orders
       WHERE created_at >= NOW() - make_interval(days => :days)`,
      { days: windowDays },
    );
    insuranceCheckout = {
      started: Number(row?.started || 0),
      paid: Number(row?.paid || 0),
      agentPaid: Number(row?.agent_paid || 0),
    };
  } catch {
    /* table optional */
  }

  let sipOrders = { started: 0, active: 0, agentActive: 0 };
  try {
    const [[row]] = await pool.execute(
      `SELECT
         COUNT(*)::int AS started,
         SUM(CASE WHEN status IN ('mandate_pending', 'active') THEN 1 ELSE 0 END)::int AS active,
         SUM(CASE WHEN status = 'active' AND sourced_agent_code IS NOT NULL AND sourced_agent_code != '' THEN 1 ELSE 0 END)::int AS agent_active
       FROM mutual_fund_sip_orders
       WHERE created_at >= NOW() - make_interval(days => :days)`,
      { days: windowDays },
    );
    sipOrders = {
      started: Number(row?.started || 0),
      active: Number(row?.active || 0),
      agentActive: Number(row?.agent_active || 0),
    };
  } catch {
    /* table optional */
  }

  let topAgents = [];
  try {
    const [rows] = await pool.execute(
      `SELECT sourced_agent_code AS agent_code, COUNT(*)::int AS lead_count
       FROM marketing_leads
       WHERE created_at >= NOW() - make_interval(days => :days)
         AND sourced_agent_code IS NOT NULL AND sourced_agent_code != ''
       GROUP BY sourced_agent_code
       ORDER BY lead_count DESC
       LIMIT 10`,
      { days: windowDays },
    );
    topAgents = (rows || []).map((r) => ({
      agentCode: r.agent_code,
      leadCount: Number(r.lead_count || 0),
    }));
  } catch {
    /* column optional */
  }

  const leadsTotal = Number(leadStats?.total || 0);
  const appsTotal = Number(appStats?.total || 0);
  const profileComplete = Number(leadStats?.profile_complete || 0);

  const funnels = [
    {
      id: 'marketplace',
      label: 'Marketplace leads',
      stages: [
        { key: 'leads', label: 'Enquiries', count: leadsTotal },
        { key: 'profile', label: 'Profile complete', count: profileComplete },
        { key: 'assigned', label: 'Assigned to staff', count: Number(leadStats?.assigned || 0) },
      ],
    },
    {
      id: 'loans',
      label: 'Loan applications',
      stages: [
        { key: 'draft', label: 'Draft', count: Number(appStats?.draft || 0) },
        { key: 'submitted', label: 'Submitted / review', count: Number(appStats?.in_review || 0) },
        { key: 'approved', label: 'Approved', count: Number(appStats?.approved || 0) },
      ],
    },
    {
      id: 'insurance',
      label: 'Insurance purchase',
      stages: [
        { key: 'checkout', label: 'Checkout started', count: insuranceCheckout.started },
        { key: 'paid', label: 'Paid', count: insuranceCheckout.paid },
      ],
    },
    {
      id: 'mutual_funds',
      label: 'Mutual fund SIP',
      stages: [
        { key: 'sip', label: 'SIP started', count: sipOrders.started },
        { key: 'mandate_active', label: 'Mandate / active', count: sipOrders.active },
        { key: 'leads', label: 'MF enquiries', count: Number(leadStats?.mutual_funds || 0) },
      ],
    },
    {
      id: 'agent_attribution',
      label: 'Agent attribution',
      stages: [
        { key: 'agent_leads', label: 'Agent-attributed leads', count: Number(leadStats?.agent_attributed || 0) },
        { key: 'agent_loans', label: 'Agent-attributed loans', count: Number(appStats?.agent_attributed || 0) },
        { key: 'insurance_paid', label: 'Insurance paid (agent)', count: insuranceCheckout.agentPaid },
        { key: 'sip_mandate_active', label: 'SIP active (agent)', count: sipOrders.agentActive },
      ],
    },
    {
      id: 'employee_leads',
      label: 'Employee lead handling',
      stages: [
        { key: 'assigned', label: 'Assigned to staff', count: Number(leadStats?.assigned || 0) },
        { key: 'converted', label: 'Converted', count: Number(leadStats?.converted || 0) },
      ],
    },
  ];

  const productMix = [
    { label: 'Insurance leads', count: Number(leadStats?.insurance || 0) },
    { label: 'Mutual fund leads', count: Number(leadStats?.mutual_funds || 0) },
    { label: 'Loan applications', count: appsTotal },
    { label: 'Agent-attributed leads', count: Number(leadStats?.agent_attributed || 0) },
    { label: 'Agent-attributed loans', count: Number(appStats?.agent_attributed || 0) },
  ];

  const conversionRates = {
    leadToProfile: leadsTotal > 0 ? Math.round((profileComplete / leadsTotal) * 100) : 0,
    loanApproval: appsTotal > 0 ? Math.round((Number(appStats?.approved || 0) / appsTotal) * 100) : 0,
    insurancePayment:
      insuranceCheckout.started > 0
        ? Math.round((insuranceCheckout.paid / insuranceCheckout.started) * 100)
        : 0,
  };

  return {
    windowDays,
    funnels,
    productMix,
    topAgents,
    conversionRates,
    totals: {
      leads: leadsTotal,
      loanApplications: appsTotal,
      insuranceCheckouts: insuranceCheckout.started,
      insurancePaid: insuranceCheckout.paid,
      insurancePaidAgent: insuranceCheckout.agentPaid,
      sipOrders: sipOrders.started,
      sipActive: sipOrders.active,
      sipActiveAgent: sipOrders.agentActive,
      agentAttributedLeads: Number(leadStats?.agent_attributed || 0),
      employeeAssignedLeads: Number(leadStats?.assigned || 0),
      employeeConvertedLeads: Number(leadStats?.converted || 0),
    },
  };
}
