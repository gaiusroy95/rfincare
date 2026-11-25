import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';

import { getPool } from '../../db/pool.js';
import { isIgnorableEnsureError } from '../../db/schemaErrors.js';
import { normalizeStorageKey } from './keys.js';

/**
 * Durable copy of every uploaded file in Postgres (`stored_files`).
 *
 * Render / Cloud Run disks are wiped on every restart and are not shared between
 * instances, so files saved only to local disk disappeared ("Document file not found"
 * in admin QC). With local storage, each upload is written to disk *and* here; reads
 * fall back to this table when the disk copy is gone. Skipped when S3 is configured.
 * Disable with STORE_UPLOADS_IN_DB=false.
 */

let schemaReady = false;

export function isDbUploadStoreEnabled() {
  const raw = String(process.env.STORE_UPLOADS_IN_DB ?? '').trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(raw);
}

export async function ensureStoredFilesSchema(pool = getPool()) {
  if (schemaReady) return;
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS stored_files (
        storage_key TEXT NOT NULL,
        mime_type VARCHAR(255) NULL,
        original_name VARCHAR(512) NULL,
        size_bytes INT NOT NULL DEFAULT 0,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (storage_key)
      )
    `);
  } catch (err) {
    if (!isIgnorableEnsureError(err)) throw err;
  }
  schemaReady = true;
}

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.csv': 'text/csv',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function guessMimeType(key, fallback = 'application/octet-stream') {
  return MIME_BY_EXT[extname(String(key || '')).toLowerCase()] || fallback;
}

export async function putDbObject({ key, buffer, mimeType, originalName }) {
  const storageKey = normalizeStorageKey(key);
  if (!storageKey || !buffer?.length) return false;
  const pool = getPool();
  await ensureStoredFilesSchema(pool);
  await pool.execute(
    `INSERT INTO stored_files (storage_key, mime_type, original_name, size_bytes, data)
     VALUES (:storage_key, :mime_type, :original_name, :size_bytes, :data)
     ON CONFLICT (storage_key) DO UPDATE SET
       mime_type = EXCLUDED.mime_type,
       original_name = EXCLUDED.original_name,
       size_bytes = EXCLUDED.size_bytes,
       data = EXCLUDED.data`,
    {
      storage_key: storageKey,
      mime_type: mimeType || guessMimeType(storageKey),
      original_name: originalName ? String(originalName).slice(0, 512) : null,
      size_bytes: buffer.length,
      data: buffer,
    },
  );
  return true;
}

/**
 * Exact key first; then the same file name under any folder. Some routes save
 * `/uploads/<file>` while multer wrote `<folder>/<file>` (names are unique per upload).
 */
const LOOKUP_SQL = (columns) => `
  SELECT ${columns}
  FROM stored_files
  WHERE storage_key = :storage_key
     OR storage_key = :base_name
     OR RIGHT(storage_key, LENGTH(CAST(:suffix AS TEXT))) = CAST(:suffix AS TEXT)
  ORDER BY CASE WHEN storage_key = :storage_key THEN 0 ELSE 1 END, created_at DESC
  LIMIT 1`;

function lookupParams(storageKey) {
  const baseName = storageKey.split('/').pop();
  // Only system-generated names (they embed a Date.now() timestamp) are unique enough to
  // match by file name — never a customer's original name such as "IMG_1234.jpg".
  const unique = /\d{12,}/.test(baseName);
  const never = '//'; // no stored key or file name can equal / end with this
  return {
    storage_key: storageKey,
    base_name: unique ? baseName : never,
    suffix: unique ? `/${baseName}` : never,
  };
}

export async function getDbObject(key) {
  const storageKey = normalizeStorageKey(key);
  if (!storageKey) return null;
  const pool = getPool();
  try {
    await ensureStoredFilesSchema(pool);
    const [[row]] = await pool.execute(
      LOOKUP_SQL('mime_type, original_name, data'),
      lookupParams(storageKey),
    );
    if (!row?.data) return null;
    return {
      buffer: Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data),
      contentType: row.mime_type || guessMimeType(storageKey),
      originalName: row.original_name || null,
    };
  } catch (err) {
    if (isIgnorableEnsureError(err)) return null;
    throw err;
  }
}

export async function getDbObjectStream(key) {
  const found = await getDbObject(key);
  if (!found) return null;
  return {
    stream: Readable.from(found.buffer),
    contentType: found.contentType,
    contentLength: found.buffer.length,
  };
}

export async function dbObjectExists(key) {
  const storageKey = normalizeStorageKey(key);
  if (!storageKey) return false;
  const pool = getPool();
  try {
    await ensureStoredFilesSchema(pool);
    const [[row]] = await pool.execute(LOOKUP_SQL('1 AS ok'), lookupParams(storageKey));
    return Boolean(row);
  } catch (err) {
    if (isIgnorableEnsureError(err)) return false;
    throw err;
  }
}

export async function deleteDbObject(key) {
  const storageKey = normalizeStorageKey(key);
  if (!storageKey) return false;
  const pool = getPool();
  try {
    await ensureStoredFilesSchema(pool);
    const [result] = await pool.execute(
      `DELETE FROM stored_files WHERE storage_key = :storage_key`,
      { storage_key: storageKey },
    );
    return Number(result?.affectedRows || 0) > 0;
  } catch (err) {
    if (isIgnorableEnsureError(err)) return false;
    throw err;
  }
}

/** Storage key for a file multer wrote under one of the upload roots (null if outside). */
export function storageKeyForDiskPath(diskPath, roots = []) {
  if (!diskPath) return null;
  const abs = resolve(String(diskPath));
  for (const root of roots) {
    const rel = relative(resolve(root), abs);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.replace(/\\/g, '/');
  }
  return null;
}

/** Copy a file multer already wrote to disk into Postgres. */
export async function copyDiskFileToDb({ key, diskPath, mimeType, originalName }) {
  if (!key || !diskPath) return false;
  const buffer = await readFile(diskPath);
  return putDbObject({ key, buffer, mimeType, originalName });
}
