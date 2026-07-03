import { createCustomerNotification } from '../routes/notifications.js';

async function notificationExistsRecently(pool, customerId, titlePattern, intervalHours = 24) {
  const [[row]] = await pool.execute(
    `SELECT id FROM customer_notifications
     WHERE customer_id = :customerId
       AND title ILIKE :pattern
       AND created_at > NOW() - make_interval(hours => :hours)
     LIMIT 1`,
    { customerId, pattern: titlePattern, hours: intervalHours },
  );
  return Boolean(row?.id);
}

async function findCustomerIdByEmail(pool, email) {
  if (!email) return null;
  const [[row]] = await pool.execute(
    `SELECT id FROM user_profiles WHERE LOWER(email) = LOWER(:email) AND role = 'customer' LIMIT 1`,
    { email },
  );
  return row?.id || null;
}

function insuranceResumePath(orderId, publicToken) {
  if (!orderId || !publicToken) return '/insurance-marketplace';
  return `/insurance-marketplace?purchaseId=${orderId}&purchaseToken=${publicToken}`;
}

function sipResumePath(orderId, publicToken) {
  if (!orderId || !publicToken) return '/mutual-fund-marketplace';
  return `/mutual-fund-marketplace?sipId=${orderId}&sipToken=${publicToken}`;
}

/**
 * Create in-app notifications for abandoned checkouts and upcoming renewals.
 * Safe to call on each dashboard load (deduped per 24h).
 */
export async function ensureEngagementNotifications(pool, customerId, email) {
  const created = [];

  const abandonedRows = await pool.execute(
    `SELECT o.id, o.public_token, o.customer_email, o.customer_name, o.payment_status, o.updated_at,
            p.name AS product_name
     FROM insurance_purchase_orders o
     JOIN insurance_products p ON p.id = o.insurance_product_id
     WHERE LOWER(o.customer_email) = LOWER(:email)
       AND o.payment_status IN ('created', 'pending_payment')
       AND o.updated_at < NOW() - INTERVAL '1 hour'
     ORDER BY o.updated_at DESC
     LIMIT 3`,
    { email },
  ).catch(() => [[], []]);
  const abandoned = abandonedRows[0] || [];

  for (const order of abandoned) {
    const title = `Complete your ${order.product_name} purchase`;
    const exists = await notificationExistsRecently(pool, customerId, 'Complete your%', 24);
    if (exists) continue;
    const path = insuranceResumePath(order.id, order.public_token);
    await createCustomerNotification(pool, {
      customerId,
      title,
      message: 'You started an insurance checkout but did not complete payment. Tap to resume and secure your cover.',
      type: 'abandoned_checkout',
      data: {
        orderId: order.id,
        purchaseId: order.id,
        purchaseToken: order.public_token,
        path,
      },
    });
    created.push('abandoned_checkout');
    break;
  }

  const abandonedSipRows = await pool.execute(
    `SELECT o.id, o.public_token, o.sip_amount, o.updated_at, mf.name AS fund_name
     FROM mutual_fund_sip_orders o
     JOIN mutual_funds mf ON mf.id = o.mutual_fund_id
     WHERE LOWER(o.customer_email) = LOWER(:email)
       AND o.status = 'created'
       AND o.updated_at < NOW() - INTERVAL '1 hour'
     ORDER BY o.updated_at DESC
     LIMIT 3`,
    { email },
  ).catch(() => [[], []]);
  const abandonedSips = abandonedSipRows[0] || [];

  for (const sip of abandonedSips) {
    const title = `Complete your ${sip.fund_name} SIP`;
    const exists = await notificationExistsRecently(pool, customerId, 'Complete your%SIP%', 24);
    if (exists) continue;
    const path = sipResumePath(sip.id, sip.public_token);
    await createCustomerNotification(pool, {
      customerId,
      title,
      message: 'You started a mutual fund SIP but did not finish mandate setup. Tap to resume.',
      type: 'abandoned_sip',
      data: {
        orderId: sip.id,
        sipId: sip.id,
        sipToken: sip.public_token,
        path,
      },
    });
    created.push('abandoned_sip');
    break;
  }

  const renewalRows = await pool.execute(
    `SELECT o.id, p.name AS product_name, o.paid_at, o.created_at
     FROM insurance_purchase_orders o
     JOIN insurance_products p ON p.id = o.insurance_product_id
     WHERE LOWER(o.customer_email) = LOWER(:email)
       AND o.payment_status = 'paid'
       AND COALESCE(o.paid_at, o.created_at) < NOW() - INTERVAL '11 months'
     ORDER BY COALESCE(o.paid_at, o.created_at) ASC
     LIMIT 3`,
    { email },
  ).catch(() => [[], []]);
  const renewals = renewalRows[0] || [];

  for (const policy of renewals) {
    const title = `${policy.product_name} renewal reminder`;
    const exists = await notificationExistsRecently(pool, customerId, `%${policy.product_name}%`, 168);
    if (exists) continue;
    await createCustomerNotification(pool, {
      customerId,
      title,
      message: 'Your insurance policy may be due for renewal soon. Review options and renew to stay protected.',
      type: 'renewal_reminder',
      data: { orderId: policy.id, path: '/insurance-marketplace?service=renewal' },
    });
    created.push('renewal_reminder');
    break;
  }

  return created;
}

/** Admin/cron: process all eligible customers for engagement notifications. */
export async function runEngagementNotificationBatch(pool, { limit = 50 } = {}) {
  const [insuranceEmails] = await pool.execute(
    `SELECT DISTINCT LOWER(customer_email) AS email
     FROM insurance_purchase_orders
     WHERE customer_email IS NOT NULL
       AND (
         (payment_status IN ('created', 'pending_payment') AND updated_at < NOW() - INTERVAL '1 hour')
         OR (payment_status = 'paid' AND COALESCE(paid_at, created_at) < NOW() - INTERVAL '11 months')
       )
     LIMIT :limit`,
    { limit },
  );

  let sipEmails = [];
  try {
    const [rows] = await pool.execute(
      `SELECT DISTINCT LOWER(customer_email) AS email
       FROM mutual_fund_sip_orders
       WHERE customer_email IS NOT NULL
         AND status = 'created'
         AND updated_at < NOW() - INTERVAL '1 hour'
       LIMIT :limit`,
      { limit },
    );
    sipEmails = rows || [];
  } catch {
    sipEmails = [];
  }

  const emailSet = new Set([
    ...(insuranceEmails || []).map((r) => r.email),
    ...sipEmails.map((r) => r.email),
  ]);

  let processed = 0;
  for (const email of emailSet) {
    if (!email) continue;
    const customerId = await findCustomerIdByEmail(pool, email);
    if (!customerId) continue;
    await ensureEngagementNotifications(pool, customerId, email);
    processed += 1;
  }
  return { processed };
}
