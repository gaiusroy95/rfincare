import { readFile } from 'node:fs/promises';
import { createWorker } from 'tesseract.js';

import { getPool } from '../db/pool.js';
import { resolveUploadFilePath } from './uploadPaths.js';
import { openStoredFile } from './storage/index.js';

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Extract structured fields from OCR / plain text (India KYC patterns). */
export function extractFieldsFromText(text, documentType = '') {
  const raw = String(text || '');
  const upper = raw.toUpperCase();
  const fields = {};

  const pan = upper.match(/\b([A-Z]{5}[0-9]{4}[A-Z])\b/);
  if (pan) fields.pan = pan[1];

  const aadhaar = raw.replace(/\s/g, '').match(/\b([0-9]{12})\b/)
    || raw.match(/\b([0-9]{4}\s[0-9]{4}\s[0-9]{4})\b/);
  if (aadhaar) fields.aadhaar = String(aadhaar[1]).replace(/\s/g, '');

  const ifsc = upper.match(/\b([A-Z]{4}0[A-Z0-9]{6})\b/);
  if (ifsc) fields.ifsc = ifsc[1];

  const account = raw.match(/\b(?:A\/C|ACCOUNT|ACCT)[^\d]{0,12}([0-9]{9,18})\b/i);
  if (account) fields.accountNumber = account[1];

  const dob = raw.match(/\b(\d{2}[\/\-]\d{2}[\/\-]\d{4})\b/);
  if (dob) fields.dateOfBirth = dob[1];

  const pincode = raw.match(/\b([1-9][0-9]{5})\b/);
  if (pincode) fields.pincode = pincode[1];

  const email = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (email) fields.email = email[0];

  const phone = raw.match(/\b([6-9][0-9]{9})\b/);
  if (phone) fields.phone = phone[1];

  // Name heuristic near "Name" label
  const nameMatch = raw.match(/(?:Name|Holder Name|Applicant)[:\s]+([A-Za-z][A-Za-z .]{2,40})/i);
  if (nameMatch) fields.name = nameMatch[1].trim();

  const type = String(documentType || '').toLowerCase();
  fields.detectedDocumentHints = [];
  if (fields.pan || /permanent account|income tax/i.test(raw)) fields.detectedDocumentHints.push('pan');
  if (fields.aadhaar || /aadhaar|uidai/i.test(raw)) fields.detectedDocumentHints.push('aadhaar');
  if (fields.ifsc || /passbook|statement/i.test(raw)) fields.detectedDocumentHints.push('bank');
  if (/salary|payslip|pay slip/i.test(raw)) fields.detectedDocumentHints.push('salary_slip');
  if (type) fields.expectedType = type;

  return fields;
}

function scoreMatch(fields, profile = {}) {
  const checks = [];
  let matched = 0;
  let compared = 0;

  const compare = (key, a, b, label) => {
    if (!a || !b) return;
    compared += 1;
    const ok = String(a).replace(/\s/g, '').toLowerCase() === String(b).replace(/\s/g, '').toLowerCase();
    if (ok) matched += 1;
    checks.push({ field: label || key, expected: b, found: a, match: ok });
  };

  compare('pan', fields.pan, profile.pan || profile.panNumber, 'PAN');
  compare('aadhaar', fields.aadhaar, profile.aadhaar || profile.aadhaarNumber, 'Aadhaar');
  compare('phone', fields.phone, profile.phone || profile.mobile, 'Phone');
  compare('email', fields.email, profile.email, 'Email');
  if (fields.name && (profile.fullName || profile.name)) {
    compared += 1;
    const a = fields.name.toLowerCase();
    const b = String(profile.fullName || profile.name).toLowerCase();
    const ok = a.includes(b.split(' ')[0]) || b.includes(a.split(' ')[0]);
    if (ok) matched += 1;
    checks.push({ field: 'Name', expected: b, found: a, match: ok });
  }

  const confidence = compared > 0 ? matched / compared : fields.pan || fields.aadhaar ? 0.55 : 0.35;
  let suggestion = 'needs_review';
  if (compared > 0 && matched === compared) suggestion = 'likely_match';
  else if (compared > 0 && matched === 0) suggestion = 'mismatch';
  else if (!compared && (fields.pan || fields.aadhaar || fields.ifsc)) suggestion = 'fields_extracted';

  return { checks, confidence, suggestion, matched, compared };
}

async function readDocumentBuffer(doc) {
  const path = resolveUploadFilePath(doc.file_path || doc.document_url, [doc.document_name]);
  if (path) {
    return readFile(path);
  }
  try {
    const opened = await openStoredFile(doc.file_path || doc.document_url);
    if (opened?.buffer) return opened.buffer;
    if (opened?.stream) {
      const chunks = [];
      for await (const chunk of opened.stream) chunks.push(chunk);
      return Buffer.concat(chunks);
    }
  } catch {
    /* fall through */
  }
  return null;
}

async function extractTextFromBuffer(buffer, mimeType = '') {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('text') || mime.includes('csv') || mime.includes('json')) {
    return { text: buffer.toString('utf8'), engine: 'plaintext' };
  }

  if (mime.includes('pdf')) {
    try {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: buffer });
      await parser.load();
      const textResult = await parser.getText();
      const text = typeof textResult === 'string'
        ? textResult
        : textResult?.text || Object.values(textResult || {}).filter((v) => typeof v === 'string').join('\n');
      await parser.destroy().catch(() => {});
      return { text: text || '', engine: 'pdf-parse' };
    } catch (err) {
      return {
        text: buffer.toString('utf8').replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' '),
        engine: 'pdf-binary-fallback',
        error: err.message,
      };
    }
  }

  if (mime.includes('image') || mime.includes('jpeg') || mime.includes('png') || mime.includes('webp')) {
    try {
      const worker = await createWorker('eng');
      const result = await worker.recognize(buffer);
      await worker.terminate();
      return {
        text: result?.data?.text || '',
        engine: 'tesseract.js',
        confidence: Number(result?.data?.confidence || 0) / 100,
      };
    } catch (err) {
      return { text: '', engine: 'tesseract-unavailable', error: err.message };
    }
  }

  return { text: buffer.toString('utf8', 0, Math.min(buffer.length, 50000)), engine: 'buffer-scan' };
}

export async function ensureOcrColumns(pool = getPool()) {
  await pool.execute(`ALTER TABLE customer_documents ADD COLUMN IF NOT EXISTS ocr_status VARCHAR(32) NULL`);
  await pool.execute(`ALTER TABLE customer_documents ADD COLUMN IF NOT EXISTS ocr_engine VARCHAR(64) NULL`);
  await pool.execute(`ALTER TABLE customer_documents ADD COLUMN IF NOT EXISTS ocr_confidence NUMERIC(8, 4) NULL`);
  await pool.execute(`ALTER TABLE customer_documents ADD COLUMN IF NOT EXISTS ocr_payload JSON NULL`);
  await pool.execute(`ALTER TABLE customer_documents ADD COLUMN IF NOT EXISTS ocr_ran_at TIMESTAMPTZ NULL`);
  await pool.execute(`ALTER TABLE customer_documents ADD COLUMN IF NOT EXISTS ocr_suggestion VARCHAR(64) NULL`);
}

/**
 * Run OCR (or accept client-provided text), extract fields, score vs profile, persist.
 */
export async function runDocumentOcr(documentId, { profile = {}, extractedText = null } = {}) {
  const pool = getPool();
  await ensureOcrColumns(pool);
  const [[doc]] = await pool.query(`SELECT * FROM customer_documents WHERE id = :id`, { id: documentId });
  if (!doc) {
    const e = new Error('Document not found');
    e.status = 404;
    throw e;
  }

  let text = extractedText;
  let engine = 'client-provided';
  let ocrConfidence = null;

  if (!text) {
    const buffer = await readDocumentBuffer(doc);
    if (!buffer) {
      const e = new Error('Document file not readable for OCR');
      e.status = 404;
      throw e;
    }
    const extracted = await extractTextFromBuffer(buffer, doc.mime_type);
    text = extracted.text;
    engine = extracted.engine;
    ocrConfidence = extracted.confidence ?? null;
    if (extracted.error && !text) {
      const e = new Error(`OCR failed: ${extracted.error}`);
      e.status = 422;
      throw e;
    }
  }

  const fields = extractFieldsFromText(text, doc.document_type);
  const score = scoreMatch(fields, profile);
  const confidence = ocrConfidence != null
    ? Number(((ocrConfidence + score.confidence) / 2).toFixed(4))
    : Number(score.confidence.toFixed(4));

  const payload = {
    textPreview: String(text || '').slice(0, 4000),
    fields,
    checks: score.checks,
    matched: score.matched,
    compared: score.compared,
  };

  await pool.execute(
    `UPDATE customer_documents SET
       ocr_status = 'completed',
       ocr_engine = :engine,
       ocr_confidence = :confidence,
       ocr_payload = :payload,
       ocr_ran_at = NOW(),
       ocr_suggestion = :suggestion
     WHERE id = :id`,
    {
      id: documentId,
      engine,
      confidence,
      payload: JSON.stringify(payload),
      suggestion: score.suggestion,
    },
  );

  const [[updated]] = await pool.query(`SELECT * FROM customer_documents WHERE id = :id`, { id: documentId });
  return {
    documentId,
    engine,
    confidence,
    suggestion: score.suggestion,
    fields,
    checks: score.checks,
    textPreview: payload.textPreview,
    ocr_payload: parseJson(updated.ocr_payload),
    ocr_status: updated.ocr_status,
    ocr_suggestion: updated.ocr_suggestion,
  };
}
