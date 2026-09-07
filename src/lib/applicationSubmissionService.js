import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getPool } from '../db/pool.js';
import { getUploadDir } from './uploadPaths.js';
import { buildBankLoanApplicationFormPdf } from './bankLoanApplicationFormPdf.js';
import { sendEmail } from './email.js';
import { sendMsg91TransactionalSms } from './msg91.js';
import { writeAuditLog } from './audit.js';
import { createCustomerNotification } from '../routes/notifications.js';
import { getUserNotificationPreferences } from './expoPushService.js';
import { autoAssignApplicationsForEmployeeVerification } from './employeeApplicationAssignment.js';

function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function field(data, camel, snake) {
  return data[camel] ?? data[snake];
}

function applicantName(data, row) {
  const parts = [
    field(data, 'title', 'title'),
    field(data, 'firstName', 'first_name'),
    field(data, 'middleName', 'middle_name'),
    field(data, 'lastName', 'last_name'),
  ].filter(Boolean);
  if (parts.length) return parts.join(' ');
  return row.customer_full_name || '—';
}

export async function finalizeApplicationSubmission({
  applicationId,
  submittedByUserId,
  submittedByRole,
  clientIp = null,
}) {
  const pool = getPool();
  const [[row]] = await pool.execute(
    `SELECT la.*, c.full_name AS customer_full_name, c.email AS customer_email, c.phone AS customer_phone
     FROM loan_applications la
     LEFT JOIN user_profiles c ON c.id = la.customer_id
     WHERE la.id = :id LIMIT 1`,
    { id: applicationId },
  );
  if (!row) {
    const e = new Error('Application not found');
    e.status = 404;
    throw e;
  }

  const data = parseJson(row.data);
  const [documents] = await pool.execute(
    `SELECT document_type, document_name, mime_type, created_at
     FROM customer_documents WHERE application_id = :id ORDER BY created_at ASC`,
    { id: applicationId },
  );
  const [consents] = await pool.execute(
    `SELECT consent_type, is_granted, granted_at
     FROM application_consents WHERE application_id = :id ORDER BY granted_at ASC`,
    { id: applicationId },
  );

  const pdfBuffer = await buildBankLoanApplicationFormPdf({
    row,
    data,
    documents,
    consents,
  });

  const packageDir = resolve(getUploadDir(), 'application-packages');
  mkdirSync(packageDir, { recursive: true });
  const safeNumber = String(row.application_number || applicationId).replace(/[^\w-]/g, '_');
  const fileName = `${safeNumber}.pdf`;
  const absolutePath = resolve(packageDir, fileName);
  writeFileSync(absolutePath, pdfBuffer);

  const publicPath = `/uploads/application-packages/${fileName}`;
  const mergedData = {
    ...data,
    application_package_pdf: publicPath,
    application_package_generated_at: new Date().toISOString(),
  };

  await pool.execute(
    `UPDATE loan_applications SET data = :data WHERE id = :id`,
    { id: applicationId, data: JSON.stringify(mergedData) },
  );

  const applicant = applicantName(data, row);
  const submittedAt = row.submitted_at || new Date();
  const appNumber = row.application_number || applicationId;

  const notificationResults = { email: false, sms: false };
  const email = field(data, 'email', 'email') || row.customer_email;
  const phone = field(data, 'phone', 'phone') || row.customer_phone;

  const emailSubject = `Rfincare Application Submitted — ${appNumber}`;
  const emailBody = [
    `Dear ${applicant},`,
    '',
    'Your loan application has been submitted successfully.',
    '',
    `Application ID: ${appNumber}`,
    `Submitted at: ${new Date(submittedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
    `Status: Submitted Successfully`,
    '',
    'You can track your application status from your customer dashboard.',
    'Our team will review your application and contact you with updates.',
    '',
    'Thank you for choosing Rfincare.',
    'support@rfincare.com | +91-7696664657',
  ].join('\n');

  try {
    const emailResult = await sendEmail({
      to: email,
      subject: emailSubject,
      text: emailBody,
      html: emailBody.replace(/\n/g, '<br/>'),
    });
    notificationResults.email = Boolean(emailResult?.sent);
  } catch (err) {
    console.warn('[submission] email failed:', err.message);
  }

  const smsMessage = `Rfincare: Your application ${appNumber} has been submitted successfully. Track status in your dashboard.`;
  try {
    const prefs = await getUserNotificationPreferences(row.customer_id);
    if (phone && prefs.sms !== false && process.env.MSG91_AUTH_KEY) {
      await sendMsg91TransactionalSms({ phone, message: smsMessage });
      notificationResults.sms = true;
    } else if (phone) {
      console.log('[submission-sms]', phone, smsMessage);
      notificationResults.sms = process.env.LOG_OTP === 'true';
    }
  } catch (err) {
    console.warn('[submission] sms failed:', err.message);
  }

  try {
    await createCustomerNotification(pool, {
      customerId: row.customer_id,
      title: 'Application submitted',
      message: `Your application ${appNumber} has been submitted successfully. Reference: ${appNumber}`,
    });
  } catch {
    /* notifications table may be missing on older DBs */
  }

  try {
    await writeAuditLog({
      userId: submittedByUserId,
      actionType: 'SUBMIT',
      tableName: 'loan_applications',
      recordId: applicationId,
      newValues: {
        status: 'submitted',
        application_number: appNumber,
        submitted_by_role: submittedByRole,
        submitted_by_user_id: submittedByUserId,
        client_ip: clientIp,
        agent_code: row.sourced_agent_code || null,
        pdf_path: publicPath,
        document_count: documents.length,
        notifications: notificationResults,
      },
    });
  } catch (err) {
    console.warn('[submission] audit log failed:', err.message);
  }

  try {
    await autoAssignApplicationsForEmployeeVerification(pool);
  } catch (err) {
    console.warn('[submission] employee auto-assign failed:', err.message);
  }

  return {
    applicationId,
    applicationNumber: appNumber,
    applicantName: applicant,
    submittedAt,
    status: 'submitted',
    statusLabel: 'Submitted Successfully',
    pdfUrl: publicPath,
    documentCount: documents.length,
    notifications: notificationResults,
  };
}
