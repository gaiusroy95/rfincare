import { sendEmail, smtpConfigured } from './email.js';
import { generateReportSection } from './reportGenerators.js';
import { buildMasterReport } from './masterReport.js';

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value) || fallback;
  } catch {
    return fallback;
  }
}

function escapeCsvCell(value) {
  if (value == null) return '';
  const str = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function buildCsvContent(columns, rows) {
  const header = columns.map(escapeCsvCell).join(',');
  const body = (rows || [])
    .map((row) => columns.map((col) => escapeCsvCell(row?.[col])).join(','))
    .join('\r\n');
  return `\uFEFF${header}\r\n${body}`;
}

function defaultDateRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 29);
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  const formatSql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  return { start: formatSql(start), end: formatSql(end), startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

function indiaNowParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    weekday: String(get('weekday') || '').toLowerCase(),
    day: Number(get('day') || 0),
    hour: Number(get('hour') || 0),
    minute: Number(get('minute') || 0),
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

function parseRecipients(raw) {
  return String(raw || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
}

function normalizeFormat(format) {
  const f = String(format || 'csv').toLowerCase();
  if (f === 'excel' || f === 'xlsx') return 'csv';
  if (f === 'pdf') return 'csv';
  return 'csv';
}

function lastRunIndiaDateKey(lastRunAt) {
  if (!lastRunAt) return null;
  return indiaNowParts(new Date(lastRunAt)).dateKey;
}

/**
 * Decide if a schedule should run now (IST).
 * Cron is expected to hit about once per hour.
 */
export function isScheduleDue(schedule, now = new Date()) {
  const cfg = parseJson(schedule.filters_json);
  const nowParts = indiaNowParts(now);
  const [hh, mm] = String(cfg.time || '09:00').split(':').map((n) => Number(n) || 0);
  const scheduleMinutes = hh * 60 + mm;
  const nowMinutes = nowParts.hour * 60 + nowParts.minute;

  // Only within a 75-minute window after configured time (covers hourly cron).
  if (nowMinutes < scheduleMinutes || nowMinutes > scheduleMinutes + 75) {
    return false;
  }

  const lastKey = lastRunIndiaDateKey(schedule.last_run_at);
  if (lastKey === nowParts.dateKey) return false;

  const frequency = String(schedule.frequency || 'weekly').toLowerCase();
  if (frequency === 'daily') return true;

  if (frequency === 'weekly') {
    const wanted = String(cfg.dayOfWeek || 'monday').toLowerCase();
    return nowParts.weekday === wanted;
  }

  if (frequency === 'monthly') {
    const dayOfMonth = Number(cfg.dayOfMonth || 1);
    return nowParts.day === dayOfMonth;
  }

  if (frequency === 'quarterly') {
    const month = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        month: 'numeric',
      }).format(now),
    );
    const isQuarterMonth = [1, 4, 7, 10].includes(month);
    const wanted = String(cfg.dayOfWeek || 'monday').toLowerCase();
    return isQuarterMonth && nowParts.day <= 7 && nowParts.weekday === wanted;
  }

  return false;
}

async function buildReportAttachment(pool, schedule) {
  const range = defaultDateRange();
  const params = { start: range.start, end: range.end };
  const reportKey = schedule.report_key;
  let filename;
  let csv;

  if (reportKey === 'master') {
    const master = await buildMasterReport(pool, params, {
      startDate: range.startDate,
      endDate: range.endDate,
    });
    const blocks = (master.sections || []).map((section) => {
      const title = `# ${section.name || section.key}`;
      return `${title}\r\n${buildCsvContent(section.columns, section.rows)}`;
    });
    csv = `\uFEFFRfincare Master Report\r\nPeriod: ${range.startDate} to ${range.endDate}\r\n\r\n${blocks.join('\r\n\r\n')}`;
    filename = `master-report-${range.endDate}.csv`;
  } else {
    const { columns, rows } = await generateReportSection(pool, reportKey, params);
    csv = buildCsvContent(columns, rows);
    filename = `${reportKey}-${range.endDate}.csv`;
  }

  return {
    filename,
    content: Buffer.from(csv, 'utf8'),
    contentType: 'text/csv',
    rowHint: csv.split(/\r?\n/).length - 1,
  };
}

export async function sendScheduledReportEmail(pool, schedule, { force = false } = {}) {
  const recipients = parseRecipients(schedule.recipients);
  if (!recipients.length) {
    return { ok: false, reason: 'no_valid_recipients', scheduleId: schedule.id };
  }

  if (!force && !isScheduleDue(schedule)) {
    return { ok: false, reason: 'not_due', scheduleId: schedule.id };
  }

  if (!smtpConfigured()) {
    return {
      ok: false,
      reason: 'smtp_not_configured',
      scheduleId: schedule.id,
      warning: 'Set SMTP_HOST / SMTP_USER / SMTP_PASS / SMTP_FROM to deliver scheduled report emails.',
    };
  }

  const attachment = await buildReportAttachment(pool, schedule);
  const subject = `[Rfincare] ${schedule.report_name || schedule.report_key} (${schedule.frequency})`;
  const text = [
    `Your scheduled Rfincare report is ready.`,
    ``,
    `Report: ${schedule.report_name || schedule.report_key}`,
    `Frequency: ${schedule.frequency}`,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `The CSV file is attached.`,
    `If you did not expect this email, contact support@rfincare.com.`,
  ].join('\n');

  const mail = await sendEmail({
    to: recipients.join(', '),
    subject,
    text,
    html: `<p>Your scheduled <strong>Rfincare</strong> report is ready.</p>
      <p><strong>Report:</strong> ${schedule.report_name || schedule.report_key}<br/>
      <strong>Frequency:</strong> ${schedule.frequency}</p>
      <p>The CSV file is attached.</p>`,
    attachments: [
      {
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType,
      },
    ],
  });

  if (!mail.sent) {
    return {
      ok: false,
      reason: mail.reason || 'email_failed',
      warning: mail.warning,
      scheduleId: schedule.id,
      recipients,
    };
  }

  await pool.execute(
    `UPDATE report_schedules
     SET last_run_at = NOW(), updated_at = NOW()
     WHERE id = :id`,
    { id: schedule.id },
  );

  return {
    ok: true,
    scheduleId: schedule.id,
    reportKey: schedule.report_key,
    recipients,
    filename: attachment.filename,
  };
}

export async function runDueReportSchedules(pool, { limit = 50, forceAll = false } = {}) {
  const [schedules] = await pool.execute(
    `SELECT * FROM report_schedules
     WHERE is_active = TRUE
     ORDER BY COALESCE(last_run_at, created_at) ASC
     LIMIT :limit`,
    { limit: Math.min(100, Math.max(1, Number(limit) || 50)) },
  );

  const results = [];
  for (const schedule of schedules) {
    try {
      const result = await sendScheduledReportEmail(pool, schedule, { force: forceAll });
      results.push(result);
    } catch (err) {
      results.push({
        ok: false,
        scheduleId: schedule.id,
        reason: err?.message || 'run_failed',
      });
    }
  }

  return {
    checked: schedules.length,
    sent: results.filter((r) => r.ok).length,
    skipped: results.filter((r) => !r.ok && r.reason === 'not_due').length,
    failed: results.filter((r) => !r.ok && r.reason !== 'not_due').length,
    results,
    smtpConfigured: smtpConfigured(),
  };
}

export { normalizeFormat, parseRecipients };
