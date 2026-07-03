/**
 * Unified customer 360 view — merges profile, products, leads, and engagement signals.
 */

function safeJson(val) {
  if (!val) return null;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch {
    return null;
  }
}

function insuranceResumePath(orderId, publicToken) {
  if (!orderId || !publicToken) return '/insurance-marketplace';
  return `/insurance-marketplace?purchaseId=${orderId}&purchaseToken=${publicToken}`;
}

function sipResumePath(orderId, publicToken) {
  if (!orderId || !publicToken) return '/mutual-fund-marketplace';
  return `/mutual-fund-marketplace?sipId=${orderId}&sipToken=${publicToken}`;
}

export async function buildCustomer360(pool, customerId, email) {
  const [[profile]] = await pool.execute(
    `SELECT id, full_name, email, phone, customer_code, created_at, role
     FROM user_profiles WHERE id = :id LIMIT 1`,
    { id: customerId },
  );

  const normalizedEmail = (email || profile?.email || '').toLowerCase();

  const [applications] = await pool.execute(
    `SELECT id, status, application_number, data, created_at, updated_at, submitted_at
     FROM loan_applications WHERE customer_id = :id ORDER BY updated_at DESC LIMIT 25`,
    { id: customerId },
  );

  const [documents] = await pool.execute(
    `SELECT id, document_type, verification_status, status, uploaded_at
     FROM customer_documents WHERE customer_id = :id ORDER BY COALESCE(uploaded_at, created_at) DESC LIMIT 20`,
    { id: customerId },
  );

  let marketingLeads = [];
  if (normalizedEmail) {
    const [leads] = await pool.execute(
      `SELECT id, loan_type, source, status, eligibility_data, created_at, updated_at
       FROM marketing_leads WHERE LOWER(email) = LOWER(:email) ORDER BY updated_at DESC LIMIT 20`,
      { email: normalizedEmail },
    );
    marketingLeads = leads || [];
  }

  let insuranceOrders = [];
  if (normalizedEmail) {
    try {
      const [orders] = await pool.execute(
        `SELECT o.id, o.public_token, o.payment_status, o.insurer_push_status, o.insurer_policy_number,
                o.payment_amount, o.created_at, o.updated_at, o.paid_at,
                p.name AS product_name, p.insurer_name
         FROM insurance_purchase_orders o
         JOIN insurance_products p ON p.id = o.insurance_product_id
         WHERE LOWER(o.customer_email) = LOWER(:email)
         ORDER BY o.updated_at DESC LIMIT 15`,
        { email: normalizedEmail },
      );
      insuranceOrders = orders || [];
    } catch {
      insuranceOrders = [];
    }
  }

  let sipOrders = [];
  if (normalizedEmail) {
    try {
      const [orders] = await pool.execute(
        `SELECT o.id, o.public_token, o.status, o.sip_amount, o.sip_day, o.invest_url,
                o.created_at, o.updated_at, mf.name AS fund_name, mf.amc_name
         FROM mutual_fund_sip_orders o
         JOIN mutual_funds mf ON mf.id = o.mutual_fund_id
         WHERE LOWER(o.customer_email) = LOWER(:email)
         ORDER BY o.updated_at DESC LIMIT 15`,
        { email: normalizedEmail },
      );
      sipOrders = orders || [];
    } catch {
      sipOrders = [];
    }
  }

  const activeLoans = applications.filter((a) =>
    ['submitted', 'under_review', 'documents_pending', 'approved', 'disbursed'].includes(a.status),
  );

  const draftApplications = applications.filter((a) => a.status === 'draft');

  const pendingDocs = documents.filter((d) =>
    ['pending', 'uploaded'].includes(String(d.verification_status || d.status || 'pending').toLowerCase()),
  );

  const abandonedCheckouts = insuranceOrders.filter((o) =>
    ['created', 'pending_payment'].includes(o.payment_status),
  );

  const abandonedSips = sipOrders.filter((o) => {
    if (o.status !== 'created') return false;
    const updated = o.updated_at ? new Date(o.updated_at).getTime() : 0;
    return updated > 0 && Date.now() - updated > 60 * 60 * 1000;
  });

  const activeSips = sipOrders.filter((o) =>
    ['mandate_pending', 'active'].includes(o.status),
  );

  const activePolicies = insuranceOrders.filter((o) =>
    o.payment_status === 'paid' || o.insurer_push_status === 'pushed',
  );

  const renewalDue = activePolicies.filter((o) => {
    const ref = o.paid_at || o.created_at;
    if (!ref) return false;
    const months = (Date.now() - new Date(ref).getTime()) / (1000 * 60 * 60 * 24 * 30);
    return months >= 11;
  });

  const openEnquiries = marketingLeads.filter((l) =>
    !['assigned', 'converted'].includes(l.status),
  );

  const journeys = [];

  if (draftApplications.length) {
    journeys.push({
      id: `draft-${draftApplications[0].id}`,
      type: 'loan_draft',
      title: 'Complete your loan application',
      description: 'Your saved application is waiting — finish and submit.',
      path: '/customer-assessment-portal?resume=1',
      priority: 90,
      status: 'in_progress',
    });
  }

  if (abandonedCheckouts.length) {
    const checkout = abandonedCheckouts[0];
    journeys.push({
      id: `checkout-${checkout.id}`,
      type: 'abandoned_checkout',
      title: `Complete insurance purchase — ${checkout.product_name}`,
      description: 'You started checkout but did not finish payment.',
      path: insuranceResumePath(checkout.id, checkout.public_token),
      priority: 95,
      status: 'abandoned',
    });
  }

  if (abandonedSips.length) {
    const sip = abandonedSips[0];
    journeys.push({
      id: `sip-${sip.id}`,
      type: 'abandoned_sip',
      title: `Complete your SIP — ${sip.fund_name}`,
      description: 'You started a mutual fund SIP but did not finish mandate setup.',
      path: sipResumePath(sip.id, sip.public_token),
      priority: 92,
      status: 'abandoned',
    });
  }

  for (const lead of openEnquiries.slice(0, 3)) {
    const data = safeJson(lead.eligibility_data);
    const productType = lead.loan_type === 'mutual_funds' ? 'mutual fund' : lead.loan_type || 'product';
    journeys.push({
      id: `lead-${lead.id}`,
      type: 'marketplace_enquiry',
      title: `Continue your ${productType} enquiry`,
      description: data?.productLabel
        ? `You enquired about ${data.productLabel}.`
        : 'Pick up where you left off in the marketplace.',
      path:
        lead.loan_type === 'insurance'
          ? '/insurance-marketplace'
          : lead.loan_type === 'mutual_funds'
            ? '/mutual-fund-marketplace'
            : '/customer-dashboard',
      priority: 70,
      status: lead.status,
    });
  }

  if (pendingDocs.length) {
    journeys.push({
      id: 'pending-docs',
      type: 'documents',
      title: `Upload ${pendingDocs.length} pending document${pendingDocs.length > 1 ? 's' : ''}`,
      description: 'Complete KYC to speed up approvals.',
      path: '/customer-dashboard?tab=documents',
      priority: 85,
      status: 'action_required',
    });
  }

  if (renewalDue.length) {
    const policy = renewalDue[0];
    journeys.push({
      id: `renewal-${policy.id}`,
      type: 'renewal',
      title: `${policy.product_name} renewal due soon`,
      description: 'Review and renew your policy before it lapses.',
      path: '/insurance-marketplace?service=renewal',
      priority: 88,
      status: 'renewal_due',
    });
  }

  journeys.sort((a, b) => b.priority - a.priority);
  const nextBestAction = journeys[0] || null;

  return {
    profile: {
      id: profile?.id,
      fullName: profile?.full_name,
      email: profile?.email,
      phone: profile?.phone,
      customerCode: profile?.customer_code,
      memberSince: profile?.created_at,
    },
    counts: {
      activeLoans: activeLoans.length,
      draftApplications: draftApplications.length,
      openEnquiries: openEnquiries.length,
      activePolicies: activePolicies.length,
      abandonedCheckouts: abandonedCheckouts.length,
      abandonedSips: abandonedSips.length,
      sipOrders: sipOrders.length,
      activeSips: activeSips.length,
      pendingDocuments: pendingDocs.length,
      renewalDue: renewalDue.length,
    },
    journeys,
    nextBestAction,
    recentActivity: [
      ...applications.slice(0, 5).map((a) => ({
        type: 'loan_application',
        id: a.id,
        label: a.application_number || a.id,
        status: a.status,
        at: a.updated_at,
      })),
      ...insuranceOrders.slice(0, 5).map((o) => ({
        type: 'insurance_order',
        id: o.id,
        label: o.product_name,
        status: o.payment_status,
        at: o.updated_at,
      })),
      ...sipOrders.slice(0, 5).map((o) => ({
        type: 'sip_order',
        id: o.id,
        label: o.fund_name,
        status: o.status,
        at: o.updated_at,
      })),
      ...marketingLeads.slice(0, 3).map((l) => ({
        type: 'marketing_lead',
        id: l.id,
        label: l.loan_type,
        status: l.status,
        at: l.updated_at,
      })),
    ]
      .sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))
      .slice(0, 10),
  };
}
