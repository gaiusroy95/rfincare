import { basename } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Sanitize a user-provided filename for storage keys. */
export function sanitizeFileName(originalName = 'file') {
  const base = basename(String(originalName || 'file'));
  return base.replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
}

/** Build a unique object key, optionally namespaced by folder. */
export function buildObjectKey(originalName, folder = '') {
  const safe = sanitizeFileName(originalName);
  const unique = `${Date.now()}-${randomBytes(4).toString('hex')}-${safe}`;
  const normalizedFolder = String(folder || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  return normalizedFolder ? `${normalizedFolder}/${unique}` : unique;
}

/**
 * Normalize DB-stored paths to a storage key.
 * Supports legacy `/uploads/foo.pdf`, `uploads/foo.pdf`, and bare keys.
 */
export function normalizeStorageKey(storedPath) {
  if (!storedPath) return null;
  const trimmed = String(storedPath).trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return null;
  const withoutPrefix = trimmed
    .replace(/^\/uploads\//i, '')
    .replace(/^uploads[\\/]/i, '');
  return withoutPrefix.replace(/\\/g, '/');
}

/** Value stored in DB and returned to clients as a stable relative path. */
export function toStoredPath(objectKey) {
  const key = normalizeStorageKey(objectKey);
  if (!key) return null;
  return `/uploads/${key}`;
}
