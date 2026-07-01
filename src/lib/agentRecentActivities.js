import { ensureStaffMessagingSchema } from '../db/ensureStaffMessagingSchema.js';
import { calculateCommissionFromApplication } from './agentCustomerProvision.js';

const STATUS_LABELS = {
  draft: 'Draft',
  submitted: 'Submitted',
  pending: 'Pending',
  under_review: 'Under review',
  documents_pending: 'Documents pending',
  approved: 'Approved',
  rejected: 'Rejected',
  disbursed: 'Disbursed',
};

const DOCUMENT_TYPE_LABELS = {
  pan_card: 'PAN card',
  aadhaar_card: 'Aadhaar card',
  income_proof: 'Income proof',
  bank_statement: 'Bank statement',
  customer_photo: 'Customer photo',
};

function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function formatLoanAmount(data) {
  const amount =
    data.requested_loan_amount ??
    data.requestedLoanAmount ??
    data.loan_amount ??
    data.loanAmount;
  if (amount == null || amount === '') return null;
  const num = Number(String(amount).replace(/,/g, ''));
  if (!Number.isFinite(num)) return null;
  return `₹${num.toLocaleString('en-IN')}`;
}

function formatStatus(status) {
  return STATUS_LABELS[status] || String(status || '').replace(/_/g, ' ') || 'Updated';
}

function formatDocumentLabel(doc) {
  const type = doc.document_type || doc.documentType;
  if (type && DOCUMENT_TYPE_LABELS[type]) return DOCUMENT_TYPE_LABELS[type];
  if (doc.document_name || doc.documentName) return doc.document_name || doc.documentName;
  if (type) return String(type).replace(/_/g, ' ');
  return 'Document';
}

function loanTypeLabel(data) {
  return data.loan_type_label || data.loan_type || data.loan_purpose || 'loan';
}

function agentAppFilterSql(alias = 'la') {
  return `(
    ${alias}.agent_id = :agentId
    OR (:agentCode IS NOT NULL AND ${alias}.sourced_agent_code = :agentCode)
  )`;
}

function pushActivity(list, activity) {
  if (!activity?.timestamp) return;
  list.push(activity);
}

/**
 * Build a chronological activity feed for the agent dashboard from real portal data.
 */
export async function buildAgentRecentActivities(
  pool,
  { agentId, agentCode, commissionConfig = null, limit = 15 },
) {
  const activities = [];
  const fetchLimit = Math.max(limit * 2, 20);
  const params = { agentId, agentCode, limit: fetchLimit };
  const appFilter = agentAppFilterSql('la');

  const [newApps] = await pool.execute(
    `SELECT la.id, la.created_at, la.application_number, la.status, la.data,
            c.full_name AS customer_name
     FROM loan_applications la
     LEFT JOIN user_profiles c ON c.id = la.customer_id
     WHERE ${appFilter}
     ORDER BY la.created_at DESC
     LIMIT :limit`,
    params,
  );

  for (const row of newApps || []) {
    const data = parseJson(row.data);
    pushActivity(activities, {
      id: `app-new-${row.id}`,
      type: 'client-added',
      title: 'New client registered',
      description: `${row.customer_name || 'Customer'} added for ${loanTypeLabel(data)} application`,
      clientName: row.customer_name || 'Customer',
      timestamp: row.created_at,
      metadata: {
        amount: formatLoanAmount(data),
        status: row.application_number,
      },
    });
  }

  const [submittedApps] = await pool.execute(
    `SELECT la.id, la.submitted_at, la.application_number, la.data,
            c.full_name AS customer_name
     FROM loan_applications la
     LEFT JOIN user_profiles c ON c.id = la.customer_id
     WHERE ${appFilter}
       AND la.submitted_at IS NOT NULL
     ORDER BY la.submitted_at DESC
     LIMIT :limit`,
    params,
  );

  for (const row of submittedApps || []) {
    const data = parseJson(row.data);
    pushActivity(activities, {
      id: `app-submit-${row.id}-${row.submitted_at}`,
      type: 'application-submitted',
      title: 'Application submitted',
      description: `${row.customer_name || 'Customer'} submitted ${loanTypeLabel(data)} application`,
      clientName: row.customer_name || 'Customer',
      timestamp: row.submitted_at,
      metadata: {
        amount: formatLoanAmount(data),
        status: 'Submitted',
      },
    });
  }

  try {
    const [timeline] = await pool.execute(
      `SELECT at.id, at.application_id, at.status, at.message, at.created_at,
              c.full_name AS customer_name, la.data
       FROM application_timeline at
       INNER JOIN loan_applications la ON la.id = at.application_id
       LEFT JOIN user_profiles c ON c.id = la.customer_id
       WHERE ${appFilter}
       ORDER BY at.created_at DESC
       LIMIT :limit`,
      params,
    );

    for (const row of timeline || []) {
      const data = parseJson(row.data);
      const statusLabel = formatStatus(row.status);
      pushActivity(activities, {
        id: `timeline-${row.id}`,
        type: 'status-changed',
        title: 'Application status updated',
        description:
          row.message ||
          `${row.customer_name || 'Customer'} application moved to ${statusLabel.toLowerCase()} stage`,
        clientName: row.customer_name || 'Customer',
        timestamp: row.created_at,
        metadata: {
          status: statusLabel,
          amount: formatLoanAmount(data),
        },
      });
    }
  } catch {
    /* application_timeline may not exist on older DBs */
  }

  try {
    const [documents] = await pool.execute(
      `SELECT cd.id, cd.document_type, cd.document_name, cd.uploaded_at, cd.created_at,
              c.full_name AS customer_name
       FROM customer_documents cd
       INNER JOIN loan_applications la ON la.id = cd.application_id
       LEFT JOIN user_profiles c ON c.id = la.customer_id
       WHERE ${appFilter}
       ORDER BY COALESCE(cd.uploaded_at, cd.created_at) DESC
       LIMIT :limit`,
      params,
    );

    for (const row of documents || []) {
      const docLabel = formatDocumentLabel(row);
      pushActivity(activities, {
        id: `doc-${row.id}`,
        type: 'document-uploaded',
        title: 'Documents submitted',
        description: `${docLabel} uploaded for ${row.customer_name || 'Customer'}`,
        clientName: row.customer_name || 'Customer',
        timestamp: row.uploaded_at || row.created_at,
        metadata: null,
      });
    }
  } catch {
    /* customer_documents may not exist on older DBs */
  }

  const [approvedApps] = await pool.execute(
    `SELECT la.id, la.updated_at, la.reviewed_at, la.status, la.data,
            c.full_name AS customer_name
     FROM loan_applications la
     LEFT JOIN user_profiles c ON c.id = la.customer_id
     WHERE ${appFilter}
       AND la.status IN ('approved', 'disbursed')
     ORDER BY COALESCE(la.reviewed_at, la.updated_at) DESC
     LIMIT :limit`,
    params,
  );

  for (const row of approvedApps || []) {
    const data = parseJson(row.data);
    const amount = calculateCommissionFromApplication(
      {
        data: {
          ...data,
          requested_loan_amount: data.requested_loan_amount || data.requestedLoanAmount,
        },
      },
      commissionConfig,
    );
    pushActivity(activities, {
      id: `commission-${row.id}-${row.status}`,
      type: 'commission-earned',
      title: row.status === 'disbursed' ? 'Loan disbursed' : 'Commission received',
      description:
        row.status === 'disbursed'
          ? `${row.customer_name || 'Customer'} loan disbursed`
          : `Payment processed for ${row.customer_name || 'Customer'} ${loanTypeLabel(data)}`,
      clientName: row.customer_name || 'Customer',
      timestamp: row.reviewed_at || row.updated_at,
      metadata: {
        amount: amount > 0 ? `₹${amount.toLocaleString('en-IN')}` : null,
        status: row.status === 'disbursed' ? 'Disbursed' : 'Paid',
      },
    });
  }

  try {
    await ensureStaffMessagingSchema();
    const [messages] = await pool.execute(
      `SELECT sm.id, sm.subject, sm.body, sm.created_at, sm.sender_id, sm.recipient_id,
              c.full_name AS customer_name
       FROM staff_messages sm
       LEFT JOIN loan_applications la ON la.id = sm.application_id
       LEFT JOIN user_profiles c ON c.id = la.customer_id
       WHERE (sm.sender_id = :agentId OR sm.recipient_id = :agentId)
         AND (sm.application_id IS NULL OR ${appFilter})
       ORDER BY sm.created_at DESC
       LIMIT :limit`,
      params,
    );

    for (const row of messages || []) {
      const isOutgoing = row.sender_id === agentId;
      pushActivity(activities, {
        id: `msg-${row.id}`,
        type: isOutgoing ? 'message-sent' : 'message-received',
        title: isOutgoing ? 'Message sent' : 'Message received',
        description:
          row.subject ||
          String(row.body || '').slice(0, 120) ||
          (row.customer_name ? `Communication regarding ${row.customer_name}` : 'Staff message'),
        clientName: row.customer_name || null,
        timestamp: row.created_at,
        metadata: null,
      });
    }
  } catch {
    /* staff messaging optional */
  }

  activities.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  const seen = new Set();
  const deduped = [];
  for (const activity of activities) {
    if (seen.has(activity.id)) continue;
    seen.add(activity.id);
    deduped.push(activity);
    if (deduped.length >= limit) break;
  }

  return deduped;
}
