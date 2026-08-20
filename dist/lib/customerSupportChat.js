import { getPool, isNoSuchTableError } from "../db/pool.js";
import { newId } from "./ids.js";
import { sendEmail } from "./email.js";
import { getSiteContactSettings } from "./siteContactSettings.js";
const WELCOME_BODY = "Hi! Welcome to Rfincare Live Chat. Tell us how we can help with loans, investments, insurance, or your application — our team typically replies within a few minutes during business hours.";
function supportInboxEmail() {
  return process.env.SUPPORT_CHAT_EMAIL || process.env.SALES_TEAM_EMAIL || process.env.SMTP_FROM || process.env.SMTP_FROM_EMAIL || "support@rfincare.com";
}
async function resolveAssignedEmployeeSupportContact(customerId) {
  const pool = getPool();
  const [[row]] = await pool.execute(
    `SELECT
        la.id AS application_id,
        la.application_number,
        la.assigned_employee_id,
        up.full_name AS employee_name,
        up.email AS employee_email,
        COALESCE(NULLIF(TRIM(CAST(eo.mobile_number AS TEXT)), ''), NULLIF(TRIM(CAST(up.phone AS TEXT)), '')) AS employee_phone,
        la.status,
        la.updated_at,
        la.created_at
     FROM loan_applications la
     LEFT JOIN user_profiles up ON up.id = la.assigned_employee_id
     LEFT JOIN employee_onboarding eo ON eo.user_id = la.assigned_employee_id
     WHERE la.customer_id = :customer_id
       AND la.assigned_employee_id IS NOT NULL
     ORDER BY
       CASE WHEN la.status IN ('approved', 'rejected') THEN 1 ELSE 0 END ASC,
       COALESCE(la.updated_at, la.created_at) DESC
     LIMIT 1`,
    { customer_id: customerId }
  );
  if (!row?.assigned_employee_id) return null;
  return {
    employeeUserId: row.assigned_employee_id,
    employeeName: row.employee_name || "",
    employeeEmail: row.employee_email || "",
    employeePhone: row.employee_phone || "",
    applicationId: row.application_id || null,
    applicationNumber: row.application_number || "",
    applicationStatus: row.status || ""
  };
}
async function canEmployeeAccessCustomerSupportChat(employeeUserId, customerId) {
  const pool = getPool();
  const [[row]] = await pool.execute(
    `SELECT id
     FROM loan_applications
     WHERE customer_id = :customer_id
       AND assigned_employee_id = :employee_id
     LIMIT 1`,
    { customer_id: customerId, employee_id: employeeUserId }
  );
  return Boolean(row?.id);
}
async function ensureSupportChatSchema(pool = getPool()) {
  try {
    await pool.execute(`SELECT 1 FROM customer_support_messages LIMIT 1`);
  } catch (err) {
    if (!isNoSuchTableError(err)) throw err;
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS customer_support_messages (
        id VARCHAR(36) PRIMARY KEY,
        customer_id VARCHAR(36) NOT NULL,
        sender_role VARCHAR(16) NOT NULL,
        sender_id VARCHAR(36) NULL,
        body TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.execute(`
      CREATE INDEX IF NOT EXISTS idx_customer_support_messages_customer_created
        ON customer_support_messages (customer_id, created_at ASC)
    `);
  }
}
function mapMessage(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    senderRole: row.sender_role,
    senderId: row.sender_id,
    body: row.body,
    createdAt: row.created_at
  };
}
async function listCustomerSupportMessages(customerId, { seedWelcome = true } = {}) {
  const pool = getPool();
  await ensureSupportChatSchema(pool);
  const [rows] = await pool.execute(
    `SELECT id, customer_id, sender_role, sender_id, body, created_at
     FROM customer_support_messages
     WHERE customer_id = :customer_id
     ORDER BY created_at ASC
     LIMIT 200`,
    { customer_id: customerId }
  );
  if (!rows.length && seedWelcome) {
    const welcome = await insertSupportMessage({
      customerId,
      senderRole: "support",
      senderId: null,
      body: WELCOME_BODY
    });
    return [welcome];
  }
  return rows.map(mapMessage);
}
async function insertSupportMessage({ customerId, senderRole, senderId, body }) {
  const pool = getPool();
  await ensureSupportChatSchema(pool);
  const id = newId();
  await pool.execute(
    `INSERT INTO customer_support_messages
       (id, customer_id, sender_role, sender_id, body)
     VALUES
       (:id, :customer_id, :sender_role, :sender_id, :body)`,
    {
      id,
      customer_id: customerId,
      sender_role: senderRole,
      sender_id: senderId,
      body
    }
  );
  return {
    id,
    customerId,
    senderRole,
    senderId,
    body,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
async function sendCustomerSupportMessage({
  customerId,
  senderId,
  body,
  customerProfile,
  supportContact = null
}) {
  const trimmed = String(body || "").trim();
  if (!trimmed) {
    const err = new Error("Message cannot be empty");
    err.status = 400;
    throw err;
  }
  if (trimmed.length > 4e3) {
    const err = new Error("Message is too long (max 4000 characters)");
    err.status = 400;
    throw err;
  }
  const message = await insertSupportMessage({
    customerId,
    senderRole: "customer",
    senderId,
    body: trimmed
  });
  const contact = await getSiteContactSettings().catch(() => null);
  const to = supportContact?.employeeEmail || supportInboxEmail() || contact?.email || "support@rfincare.com";
  const name = customerProfile?.full_name || customerProfile?.fullName || "Customer";
  const email = customerProfile?.email || "";
  const phone = customerProfile?.phone || "";
  try {
    await sendEmail({
      to,
      subject: `Live Chat — ${name}`,
      text: [
        "New customer live chat message",
        "",
        `Customer: ${name}`,
        email ? `Email: ${email}` : null,
        phone ? `Phone: ${phone}` : null,
        `Customer ID: ${customerId}`,
        supportContact?.applicationNumber ? `Application: ${supportContact.applicationNumber}` : null,
        supportContact?.employeeName ? `Assigned employee: ${supportContact.employeeName}` : null,
        "",
        trimmed,
        "",
        "Reply from Employee Portal → Support Center → Live chats."
      ].filter(Boolean).join("\n"),
      html: `
        <p><strong>New customer live chat message</strong></p>
        <p>Customer: ${name}<br/>
        ${email ? `Email: ${email}<br/>` : ""}
        ${phone ? `Phone: ${phone}<br/>` : ""}
        Customer ID: ${customerId}<br/>
        ${supportContact?.applicationNumber ? `Application: ${supportContact.applicationNumber}<br/>` : ""}
        ${supportContact?.employeeName ? `Assigned employee: ${supportContact.employeeName}<br/>` : ""}
        </p>
        <p style="white-space:pre-wrap;border-left:3px solid #059669;padding-left:12px;">${trimmed.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>
        <p style="color:#64748b;font-size:13px;">Reply from Employee Portal → Support Center → Live chats.</p>
      `
    });
  } catch {
  }
  const pool = getPool();
  const [[countRow]] = await pool.execute(
    `SELECT COUNT(*) AS cnt FROM customer_support_messages
     WHERE customer_id = :customer_id AND sender_role = 'customer'`,
    { customer_id: customerId }
  );
  let ack = null;
  if (Number(countRow?.cnt || 0) <= 1) {
    ack = await insertSupportMessage({
      customerId,
      senderRole: "support",
      senderId: null,
      body: "Thanks — we received your message. A support specialist will reply here shortly. For urgent help, use Call Support from this page."
    });
  }
  return { message, ack };
}
async function listSupportChatThreads({ limit = 40, role = "", userId = null } = {}) {
  const pool = getPool();
  await ensureSupportChatSchema(pool);
  const safeLimit = Math.min(Math.max(Number(limit) || 40, 1), 100);
  const isEmployee = role === "employee" && userId;
  const [threadRows] = await pool.execute(
    isEmployee ? `SELECT csm.customer_id AS customer_id, MAX(csm.created_at) AS last_at
         FROM customer_support_messages csm
         WHERE EXISTS (
           SELECT 1
           FROM loan_applications la
           WHERE la.customer_id = csm.customer_id
             AND la.assigned_employee_id = :employee_id
         )
         GROUP BY csm.customer_id
         ORDER BY MAX(csm.created_at) DESC
         LIMIT ${safeLimit}` : `SELECT customer_id AS customer_id, MAX(created_at) AS last_at
         FROM customer_support_messages
         GROUP BY customer_id
         ORDER BY MAX(created_at) DESC
         LIMIT ${safeLimit}`,
    isEmployee ? { employee_id: userId } : {}
  );
  const threads = [];
  for (const row of threadRows) {
    const customerId = row.customer_id;
    const assigned = await resolveAssignedEmployeeSupportContact(customerId);
    const [[profile]] = await pool.execute(
      `SELECT full_name, email, phone FROM user_profiles WHERE id = :id LIMIT 1`,
      { id: customerId }
    );
    const [[last]] = await pool.execute(
      `SELECT body, sender_role, created_at
       FROM customer_support_messages
       WHERE customer_id = :customer_id
       ORDER BY created_at DESC
       LIMIT 1`,
      { customer_id: customerId }
    );
    threads.push({
      customerId,
      fullName: profile?.full_name || "Customer",
      email: profile?.email || "",
      phone: profile?.phone || "",
      lastAt: last?.created_at || row.last_at,
      lastBody: last?.body || "",
      lastSenderRole: last?.sender_role || "",
      assignedEmployeeId: assigned?.employeeUserId || null,
      assignedEmployeeName: assigned?.employeeName || "",
      assignedEmployeeEmail: assigned?.employeeEmail || "",
      assignedEmployeePhone: assigned?.employeePhone || "",
      applicationNumber: assigned?.applicationNumber || ""
    });
  }
  return threads;
}
async function replyAsSupport({ customerId, senderId, body }) {
  const trimmed = String(body || "").trim();
  if (!trimmed) {
    const err = new Error("Message cannot be empty");
    err.status = 400;
    throw err;
  }
  return insertSupportMessage({
    customerId,
    senderRole: "support",
    senderId,
    body: trimmed
  });
}
export {
  canEmployeeAccessCustomerSupportChat,
  ensureSupportChatSchema,
  insertSupportMessage,
  listCustomerSupportMessages,
  listSupportChatThreads,
  replyAsSupport,
  resolveAssignedEmployeeSupportContact,
  sendCustomerSupportMessage
};
