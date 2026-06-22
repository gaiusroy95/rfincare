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
    'Please sign in and change your password after first login.',
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
    <p>Please change your password after your first sign-in.</p>
  `;

  return sendEmail({ to: email, subject, text, html });
}
