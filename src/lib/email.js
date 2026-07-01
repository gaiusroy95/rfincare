/**
 * Outbound email — configure SMTP_* in .env for production.
 * Falls back to console when SMTP is not configured (same pattern as OTP).
 */

export function smtpConfigured() {
  return Boolean(
    process.env.SMTP_HOST &&
      (process.env.SMTP_FROM || process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER),
  );
}

function smtpPassword() {
  const raw = process.env.SMTP_PASS || process.env.SMTP_PASSWORD || '';
  return String(raw).replace(/^["']|["']$/g, '').trim();
}

function smtpFromAddress() {
  return String(
    process.env.SMTP_FROM || process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || '',
  ).trim();
}

async function sendViaSmtp({ to, subject, text, html, attachments = [] }) {
  const nodemailer = await import('nodemailer');
  const pass = smtpPassword();
  const user = String(process.env.SMTP_USER || '').trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    requireTLS: !secure && port === 587,
    auth: user && pass ? { user, pass } : undefined,
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 10000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 10000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 15000),
  });

  await transporter.sendMail({
    from: smtpFromAddress(),
    to,
    subject,
    text,
    html: html || text,
    attachments,
  });
}

export async function sendEmail({ to, subject, text, html, attachments }) {
  if (!to) return { sent: false, reason: 'no_recipient' };

  const mailAttachments = Array.isArray(attachments)
    ? attachments.filter((a) => a?.path || a?.content)
    : [];

  if (smtpConfigured()) {
    try {
      await sendViaSmtp({ to, subject, text, html, attachments: mailAttachments });
      return {
        sent: true,
        channel: 'smtp',
        attachmentCount: mailAttachments.length,
      };
    } catch (err) {
      console.error('[email:smtp]', err?.message || err);
      return {
        sent: false,
        channel: 'smtp',
        reason: err?.code || 'smtp_error',
        warning:
          err?.message ||
          'Email could not be delivered via SMTP. Check SMTP_* env vars or hosting outbound port access.',
        attachmentCount: mailAttachments.length,
      };
    }
  }

  console.log('[email]', { to, subject }, process.env.LOG_OTP === 'true' ? text : '(body hidden)');
  return {
    sent: false,
    channel: 'log',
    reason: 'smtp_not_configured',
    warning:
      'Email was not delivered — configure SMTP_HOST and SMTP_FROM on the server. The message is saved in in-app chat only.',
    attachmentCount: mailAttachments.length,
  };
}

export async function sendStaffWelcomeEmail({ email, fullName, role, password, loginPath }) {
  const roleLabel = role === 'agent' ? 'Agent' : 'Employee';
  const appUrl = process.env.APP_PUBLIC_URL || process.env.API_PUBLIC_URL || 'http://127.0.0.1:4028';
  const loginUrl = `${appUrl.replace(/\/$/, '')}${loginPath || (role === 'agent' ? '/agent-login' : '/employee-login')}`;

  const subject = `Your Rfincare ${roleLabel} account`;
  const text = [
    `Hello ${fullName || email},`,
    '',
    `An administrator created your ${roleLabel} account on Rfincare.`,
    '',
    `Login URL: ${loginUrl}`,
    `Email: ${email}`,
    `Temporary password: ${password}`,
    '',
    'Please sign in and change your password  login.',
    '',
    '— Rfincare Team',
  ].join('\n');

  const html = `
    <p>Hello ${fullName || email},</p>
    <p>Your <strong>Rfincare ${roleLabel}</strong> account is ready.</p>
    <ul>
      <li><strong>Login:</strong> <a href="${loginUrl}">${loginUrl}</a></li>
      <li><strong>Email:</strong> ${email}</li>
      <li><strong>Password:</strong> ${password}</li>
    </ul>
    <p>Please change your password  first sign-in.</p>
  `;

  return sendEmail({ to: email, subject, text, html });
}

export async function sendPartnerApplicationAdminEmail({ recipients, applicant }) {
  const appUrl = process.env.APP_PUBLIC_URL || process.env.API_PUBLIC_URL || 'http://127.0.0.1:4028';
  const adminUrl = `${appUrl.replace(/\/$/, '')}/admin-dashboard?tab=registrations&partner=pending`;
  const toList = Array.isArray(recipients) ? recipients.filter(Boolean) : [];
  if (!toList.length) return { sent: false, reason: 'no_recipient' };

  const subject = `New partner application — ${applicant.fullName}`;
  const text = [
    'A new Rfincare partner (agent) application was submitted.',
    '',
    `Name: ${applicant.fullName}`,
    `Email: ${applicant.email}`,
    `Phone: ${applicant.phone}`,
    `PAN: ${applicant.panNumber || '—'}`,
    `Bank: ${applicant.bankName || '—'} / ${applicant.ifscCode || '—'}`,
    '',
    `Review in admin portal: ${adminUrl}`,
    '',
    '— Rfincare',
  ].join('\n');

  const html = `
    <p>A new <strong>partner application</strong> was submitted.</p>
    <ul>
      <li><strong>Name:</strong> ${applicant.fullName}</li>
      <li><strong>Email:</strong> ${applicant.email}</li>
      <li><strong>Phone:</strong> ${applicant.phone}</li>
      <li><strong>PAN:</strong> ${applicant.panNumber || '—'}</li>
      <li><strong>Bank:</strong> ${applicant.bankName || '—'} (${applicant.ifscCode || '—'})</li>
    </ul>
    <p><a href="${adminUrl}">Open admin portal to review documents</a></p>
  `;

  const results = [];
  for (const to of toList) {
    results.push(await sendEmail({ to, subject, text, html }));
  }
  return { sent: results.some((r) => r.sent), results };
}

export async function sendPartnerWelcomeEmail({
  email,
  fullName,
  username,
  password,
  agentCode,
  financialYear,
}) {
  const appUrl = process.env.APP_PUBLIC_URL || process.env.API_PUBLIC_URL || 'http://127.0.0.1:4028';
  const loginUrl = `${appUrl.replace(/\/$/, '')}/agent-login`;
  const resetUrl = `${appUrl.replace(/\/$/, '')}/agent-login?reset=1`;

  const subject = `Welcome to Rfincare — Partner account approved (${agentCode})`;
  const text = [
    `Hello ${fullName || email},`,
    '',
    'Your partner application has been approved. Welcome to the Rfincare agent network.',
    '',
    `Agent code (FY ${financialYear || 'current'}): ${agentCode}`,
    `Login URL: ${loginUrl}`,
    `Username: ${username}`,
    `Email: ${email}`,
    `Temporary password: ${password}`,
    '',
    'Sign in with the credentials above, then reset your password:',
    resetUrl,
    '',
    '— Rfincare Team',
  ].join('\n');

  const html = `
    <p>Hello ${fullName || email},</p>
    <p>Your <strong>partner application</strong> has been approved. Welcome to Rfincare.</p>
    <ul>
      <li><strong>Agent code (FY ${financialYear || 'current'}):</strong> ${agentCode}</li>
      <li><strong>Login:</strong> <a href="${loginUrl}">${loginUrl}</a></li>
      <li><strong>Username:</strong> ${username}</li>
      <li><strong>Email:</strong> ${email}</li>
      <li><strong>Temporary password:</strong> ${password}</li>
    </ul>
    <p><a href="${resetUrl}">Reset your password  sign-in</a></p>
  `;

  return sendEmail({ to: email, subject, text, html });
}

export async function sendPartnerRejectionEmail({ email, fullName, reason }) {
  const subject = 'Rfincare partner application update';
  const text = [
    `Hello ${fullName || email},`,
    '',
    'Thank you for applying to become an Rfincare partner.',
    ' your application, we are unable to approve it at this time.',
    reason ? `\nReason: ${reason}` : '',
    '',
    'You may contact support if you have questions.',
    '',
    '— Rfincare Team',
  ].join('\n');

  const html = `
    <p>Hello ${fullName || email},</p>
    <p>Thank you for your partner application. We are unable to approve it at this time.</p>
    ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
    <p>Contact support if you have questions.</p>
  `;

  return sendEmail({ to: email, subject, text, html });
}
