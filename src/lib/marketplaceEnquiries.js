const MARKETPLACE_ENQUIRY_TYPES = new Set(['insurance', 'mutual_funds']);

const MARKETPLACE_TYPE_LABELS = {
  insurance: 'Insurance',
  mutual_funds: 'Mutual Fund',
};

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function formatProductLabel(loanType, eligibilityData) {
  if (eligibilityData?.productLabel) return eligibilityData.productLabel;
  if (eligibilityData?.productCategory) {
    return String(eligibilityData.productCategory)
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return MARKETPLACE_TYPE_LABELS[loanType] || String(loanType || 'Enquiry')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function mapLeadStatusToApplicationStatus(status) {
  switch (status) {
    case 'assigned':
      return 'approved';
    case 'profile_complete':
    case 'verified':
    case 'new':
      return 'submitted';
    default:
      return 'pending';
  }
}

function resolveEnquiryAmount(eligibilityData) {
  if (!eligibilityData || typeof eligibilityData !== 'object') return null;
  const candidates = [
    eligibilityData.sumAssured,
    eligibilityData.coverageAmount,
    eligibilityData.investmentAmount,
    eligibilityData.sipAmount,
    eligibilityData.monthlySip,
  ];
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return null;
}

export function isMarketplaceProductFilter(loanType) {
  if (!loanType || loanType === 'all') return false;
  const normalized = String(loanType).toLowerCase().replace(/-/g, '_');
  return MARKETPLACE_ENQUIRY_TYPES.has(normalized);
}

function buildEnquiryStatusFilter(status, conditions, params) {
  if (!status || status === 'all') return;

  switch (status) {
    case 'pending':
      conditions.push(`ml.status IN ('new', 'verified')`);
      break;
    case 'under-review':
      conditions.push(`ml.status IN ('verified', 'profile_complete')`);
      break;
    case 'approved':
      conditions.push(`ml.status = 'assigned'`);
      break;
    case 'documents-pending':
      conditions.push(`ml.status = 'profile_complete'`);
      break;
    case 'rejected':
      conditions.push('1 = 0');
      break;
    case 'submitted':
      conditions.push(`ml.status IN ('new', 'verified', 'profile_complete')`);
      break;
    default:
      conditions.push('ml.status = :enquiryStatus');
      params.enquiryStatus = status;
  }
}

export function buildMarketplaceEnquiryQuery(filters = {}) {
  const conditions = [`ml.loan_type IN ('insurance', 'mutual_funds')`];
  const params = {};

  if (filters.search) {
    conditions.push(
      '(ml.full_name ILIKE :search OR ml.email ILIKE :search OR ml.phone ILIKE :search)',
    );
    params.search = `%${filters.search}%`;
  }

  if (filters.loanType && filters.loanType !== 'all') {
    const lt = String(filters.loanType).toLowerCase().replace(/-/g, '_');
    if (MARKETPLACE_ENQUIRY_TYPES.has(lt)) {
      conditions.push('ml.loan_type = :loanType');
      params.loanType = lt;
    } else {
      conditions.push('1 = 0');
    }
  }

  buildEnquiryStatusFilter(filters.status, conditions, params);

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, params };
}

export function formatMarketplaceEnquiryAsApplication(row) {
  const eligibilityData = parseJson(row.eligibility_data);
  const loanType = row.loan_type;
  const loanTypeLabel = formatProductLabel(loanType, eligibilityData);
  const enquiryAmount = resolveEnquiryAmount(eligibilityData);

  return {
    id: row.id,
    record_type: 'marketplace_enquiry',
    application_number: `ENQ-${String(row.id).slice(0, 8).toUpperCase()}`,
    customer_id: null,
    agent_id: null,
    sourced_agent_code: row.assignee_code || null,
    assigned_employee_id: row.assigned_to || null,
    selected_bank_id: null,
    status: mapLeadStatusToApplicationStatus(row.status),
    document_stage_status: row.status === 'profile_complete' ? 'profile_collected' : 'enquiry_received',
    bank_approval_status: 'not_applicable',
    lead_status: row.status,
    eligibility_score: row.eligibility_score,
    eligibility_data: eligibilityData,
    source: row.source,
    submitted_at: row.consent_verified_at || row.updated_at || row.created_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    loan_type: loanType,
    loan_type_label: loanTypeLabel,
    loan_amount: enquiryAmount,
    admin_priority: 'medium',
    customer: {
      id: null,
      full_name: row.full_name || 'Unknown',
      email: row.email || '',
      phone: row.phone || '',
    },
    bank: null,
    customer_photo_url: null,
    data: {
      marketplace_enquiry: true,
      loan_type: loanType,
      loan_type_label: loanTypeLabel,
      eligibility_data: eligibilityData,
      source: row.source,
      lead_status: row.status,
    },
  };
}

export async function fetchMarketplaceEnquiries(pool, filters = {}, { limit = 200 } = {}) {
  const { where, params } = buildMarketplaceEnquiryQuery(filters);
  const [rows] = await pool.execute(
    `SELECT ml.*,
            up.full_name AS assignee_name,
            up.role AS assignee_role,
            COALESCE(ao.agent_code, eo.employee_code) AS assignee_code
     FROM marketing_leads ml
     LEFT JOIN user_profiles up ON up.id = ml.assigned_to
     LEFT JOIN agent_onboarding ao ON ao.user_id = up.id AND up.role = 'agent'
     LEFT JOIN employee_onboarding eo ON eo.user_id = up.id AND up.role = 'employee'
     ${where}
     ORDER BY ml.created_at DESC
     LIMIT :limit`,
    { ...params, limit },
  );
  return (rows || []).map(formatMarketplaceEnquiryAsApplication);
}

export async function countMarketplaceEnquiries(pool, filters = {}) {
  const { where, params } = buildMarketplaceEnquiryQuery(filters);
  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*)::int AS total FROM marketing_leads ml ${where}`,
    params,
  );
  return Number(total || 0);
}
