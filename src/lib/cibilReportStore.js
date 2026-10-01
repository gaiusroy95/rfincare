import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getPool } from '../db/pool.js';
import { isIgnorableEnsureError } from '../db/schemaErrors.js';
import { getUploadDir } from './uploadPaths.js';

/**
 * Bureau report PDFs are kept in Postgres as well as on disk: Render's disk is
 * wiped on every deploy/restart, which made older report links 404.
 */

const REPORT_URL_PREFIX = '/uploads/cibil-reports/';
const SAFE_FILE_RE = /^[A-Za-z0-9._-]+\.pdf$/;

let schemaReady = false;

async function ensureCibilReportSchema(pool) {
  if (schemaReady) return;
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS cibil_report_files (
        file_name VARCHAR(255) NOT NULL,
        size_bytes INT NOT NULL DEFAULT 0,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (file_name)
      )
    `);
  } catch (err) {
    if (!isIgnorableEnsureError(err)) throw err;
  }
  schemaReady = true;
}

function reportDir() {
  return resolve(getUploadDir(), 'cibil-reports');
}

export function cibilReportFileName(reportPath) {
  const name = String(reportPath || '').split(/[/\\]/).pop() || '';
  return SAFE_FILE_RE.test(name) ? name : null;
}

export function isPdfBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 100 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

/** Persist a report PDF (disk + DB) and return its `/uploads/cibil-reports/<file>` path. */
export async function storeCibilReportPdf(buffer, fileStem) {
  const stem = String(fileStem || 'report').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'report';
  const fileName = `${stem}-${Date.now()}.pdf`;
  try {
    mkdirSync(reportDir(), { recursive: true });
    writeFileSync(resolve(reportDir(), fileName), buffer);
  } catch (err) {
    console.warn('[cibil] could not write report to disk:', err?.message || err);
  }
  const pool = getPool();
  await ensureCibilReportSchema(pool);
  await pool.execute(
    `INSERT INTO cibil_report_files (file_name, size_bytes, data)
     VALUES (:name, :size, :data)
     ON CONFLICT (file_name) DO UPDATE SET data = EXCLUDED.data, size_bytes = EXCLUDED.size_bytes`,
    { name: fileName, size: buffer.length, data: buffer },
  );
  return `${REPORT_URL_PREFIX}${fileName}`;
}

/** Load a stored report PDF by its report path (disk first, then DB). */
export async function readCibilReportPdf(reportPath) {
  const fileName = cibilReportFileName(reportPath);
  if (!fileName) return null;
  const localPath = resolve(reportDir(), fileName);
  if (existsSync(localPath)) return { fileName, buffer: readFileSync(localPath) };

  const pool = getPool();
  await ensureCibilReportSchema(pool);
  const [[row]] = await pool.execute(
    `SELECT data FROM cibil_report_files WHERE file_name = :name LIMIT 1`,
    { name: fileName },
  );
  if (!row?.data) return null;
  const buffer = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
  return { fileName, buffer };
}

/** Express helper: stream a report PDF or reply 404. */
export async function sendCibilReportPdf(res, reportPath, { disposition = 'attachment', prefix = 'cibil-report' } = {}) {
  const report = reportPath ? await readCibilReportPdf(reportPath) : null;
  if (!report) {
    res.status(404).json({ error: 'Credit report file not found. Generate the report again.' });
    return false;
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${disposition}; filename="${prefix}-${report.fileName}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(report.buffer);
  return true;
}
