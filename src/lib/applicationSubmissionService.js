import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getPool } from '../db/pool.js';
import { getUploadDir } from './uploadPaths.js';
import { buildSimpleTextPdf } from './simplePdf.js';
import { sendEmail } from './email.js';
import { sendMsg91TransactionalSms } from './msg91.js';
import { writeAuditLog } from './audit.js';
import { createCustomerNotification } from '../routes/notifications.js';

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

function formatInr(value) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return '—';
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

function formatYesNo(value) {
  if (value === 'yes' || value === true) return 'Yes';
  if (value === 'no' || value === false) return 'No';
  return value == null || value === '' ? '—' : String(value);
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

function buildApplicationPdfLines({ row, data, documents, consents }) {
  const submittedAt = row.submitted_at
    ? new Date(row.submitted_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    : new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const lines = [
    'Rfincare — Loan Application Package',
    'CONFIDENTIAL — Generated on final submission',
    '',
    'APPLICATION REFERENCE',
    `Application ID: ${row.application_number || row.id}`,
    `Internal ID: ${row.id}`,
    `Status: Submitted Successfully`,
    `Submitted at: ${submittedAt}`,
    `Tracking ref: ${row.application_number || row.id}`,
    '',
    'APPLICANT DETAILS',
    `Name: ${applicantName(data, row)}`,
    `Email: ${field(data, 'email', 'email') || row.customer_email || '—'}`,
    `Phone: ${field(data, 'phone', 'phone') || '—'}`,
    `Date of birth: ${field(data, 'dateOfBirth', 'date_of_birth') || '—'}`,
    `PAN: ${field(data, 'pan', 'pan_number') || field(data, 'panNumber', 'pan_number') || '—'}`,
    `Aadhaar: ${field(data, 'aadhaar', 'aadhaar_number') || '—'}`,
    '',
    'ADDRESS',
    `Line 1: ${field(data, 'addressLine1', 'address_line1') || '—'}`,
    `Line 2: ${field(data, 'addressLine2', 'address_line2') || '—'}`,
    `City: ${field(data, 'city', 'city') || '—'}`,
    `District: ${field(data, 'district', 'district') || '—'}`,
    `State: ${field(data, 'state', 'state') || '—'}`,
    `PIN: ${field(data, 'pinCode', 'pin_code') || '—'}`,
    '',
    'EMPLOYMENT & INCOME',
    `Employment type: ${field(data, 'employmentType', 'employment_type') || '—'}`,
    `Employer / Business: ${field(data, 'employerName', 'employer_name') || '—'}`,
    `Job title: ${field(data, 'jobTitle', 'job_title') || '—'}`,
    `Annual income: ${formatInr(field(data, 'annualIncome', 'annual_income'))}`,
    `Monthly income: ${formatInr(field(data, 'monthlyIncome', 'monthly_income'))}`,
    '',
    'LOAN / PRODUCT DETAILS',
    `Loan purpose: ${field(data, 'loanPurpose', 'loan_purpose') || row.loan_type || '—'}`,
    `Requested amount: ${formatInr(
      field(data, 'loanAmount', 'loan_amount')
        ?? field(data, 'requestedLoanAmount', 'requested_loan_amount'),
    )}`,
    `Credit score range: ${field(data, 'creditScoreRange', 'credit_score_range') || '—'}`,
    `Total monthly EMI: ${formatInr(field(data, 'monthlyDebtPayments', 'monthly_debt_payments'))}`,
    `Preferred bank: ${field(data, 'preferredBankName', 'preferred_bank_name') || '—'}`,
    '',
    'DECLARATIONS & CONSENTS',
    `Certify accuracy: ${formatYesNo(field(data, 'certifyAccuracy', 'certify_accuracy'))}`,
    `Authorize credit check: ${formatYesNo(field(data, 'authorizeCredit', 'authorize_credit'))}`,
    `Agree to terms: ${formatYesNo(field(data, 'agreeTerms', 'agree_terms'))}`,
    `Electronic signature: ${formatYesNo(field(data, 'consentSignatureAgreed', 'consent_signature_agreed'))}`,
    `Signature method: ${field(data, 'signatureMethod', 'signature_method') || field(data, 'submitAuthMethod', 'submit_auth_method') || '—'}`,
    `Signed by: ${field(data, 'signatureName', 'signature_name') || applicantName(data, row)}`,
    `Signed at: ${field(data, 'signatureSignedAt', 'signature_signed_at') || submittedAt}`,
  ];

  if (row.sourced_agent_code || row.agent_id) {
    lines.push('', 'AGENT / PARTNER');
    lines.push(`Agent code: ${row.sourced_agent_code || '—'}`);
    lines.push(`Agent ID: ${row.agent_id || '—'}`);
  }

  const existingLoans = data.existing_loans || data.existingLoans;
  if (Array.isArray(existingLoans) && existingLoans.length) {
    lines.push('', 'EXISTING LOANS / EMI');
    existingLoans.forEach((loan, index) => {
      lines.push(
        `${index + 1}. ${loan.loan_type || loan.loanType || 'Loan'} — EMI ${formatInr(loan.emi_amount ?? loan.emiAmount)}`,
      );
    });
  }

  if (consents?.length) {
    lines.push('', 'RECORDED CONSENTS');
    consents.forEach((c) => {
      lines.push(`- ${c.consent_type}: ${c.is_granted ? 'Yes' : 'No'}`);
    });
  }

  if (documents?.length) {
    lines.push('', 'UPLOADED SUPPORTING DOCUMENTS');
    documents.forEach((doc) => {
      lines.push(`- ${doc.document_type}: ${doc.document_name || 'uploaded'}`);
    });
  }

  lines.push(
    '',
    '— End of application package —',
    'For assistance: support@rfincare.com | +91-7696664657',
  );

  return lines;
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

  const pdfLines = buildApplicationPdfLines({ row, data, documents, consents });
  const pdfBuffer = buildSimpleTextPdf(pdfLines);

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
    if (phone && process.env.MSG91_AUTH_KEY) {
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
