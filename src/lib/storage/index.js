import { getStorageProviderName, isCloudStorage, isEphemeralUploadHost } from './config.js';
import {
  getLocalObjectStream,
  getLocalPublicUrl,
  localObjectExists,
  putLocalObject,
} from './localProvider.js';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  deleteS3Object,
  getS3ObjectStream,
  getS3SignedUrl,
  putS3Object,
  s3ObjectExists,
} from './s3Provider.js';
import { normalizeStorageKey, toStoredPath } from './keys.js';
import { getUploadDir } from '../uploadPaths.js';

export { getStorageProviderName, isCloudStorage, getS3Config, isEphemeralUploadHost } from './config.js';
export { normalizeStorageKey, toStoredPath, buildObjectKey, sanitizeFileName } from './keys.js';

/**
 * Persist an uploaded file buffer to the configured object store.
 * @returns {Promise<{ key: string, storedPath: string, publicUrl: string, mimeType: string }>}
 */
export async function saveUploadedFile({ buffer, originalName, folder = '', mimeType }) {
  if (!buffer?.length) {
    throw new Error('Cannot save empty upload');
  }
  if (isCloudStorage()) {
    return putS3Object({ buffer, originalName, folder, mimeType });
  }
  return putLocalObject({ buffer, originalName, folder, mimeType });
}

/** Open a readable stream for a stored object (local disk or S3). */
export async function openStoredFile(storedPath) {
  const key = normalizeStorageKey(storedPath);
  if (!key) return null;
  if (isCloudStorage()) {
    const fromS3 = await getS3ObjectStream(key);
    if (fromS3?.stream) return fromS3;
    // Migration fallback: object may still exist only on local disk from older deploys.
    const local = await getLocalObjectStream(key);
    if (local?.stream) return local;
    return null;
  }
  return getLocalObjectStream(key);
}

/** Public or app-relative URL for previews and API responses. */
export async function getStoredPublicUrl(storedPath) {
  const key = normalizeStorageKey(storedPath);
  if (!key) return null;
  if (isCloudStorage()) {
    const signed = await getS3SignedUrl(key);
    return signed || null;
  }
  return getLocalPublicUrl(key);
}

export async function storedFileExists(storedPath) {
  const key = normalizeStorageKey(storedPath);
  if (!key) return false;
  if (isCloudStorage()) {
    if (await s3ObjectExists(key)) return true;
    return localObjectExists(key);
  }
  return localObjectExists(key);
}

/** Upload roots a stored file may live under (multer routes resolve UPLOAD_DIR from cwd). */
function uploadRoots() {
  return [...new Set([getUploadDir(), resolve(process.env.UPLOAD_DIR || './uploads')])];
}

function isInside(root, target) {
  const rel = relative(root, target);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Permanently delete one stored upload: the exact object only (never a filename match).
 * Accepts DB values such as `/uploads/staff-learning/x.pdf` or an absolute disk path,
 * and refuses anything outside the upload roots.
 * @returns {Promise<string[]>} locations that were removed
 */
export async function deleteStoredFile(...storedPaths) {
  const removed = [];
  const roots = uploadRoots();
  const diskTargets = new Set();
  const keys = new Set();

  for (const value of storedPaths) {
    const raw = String(value || '').trim();
    if (!raw || /^https?:\/\//i.test(raw)) continue;
    if (isAbsolute(raw) && !raw.startsWith('/uploads/')) {
      const abs = resolve(raw);
      const root = roots.find((r) => isInside(r, abs));
      if (root) {
        diskTargets.add(abs);
        keys.add(relative(root, abs).replace(/\\/g, '/'));
      }
      continue;
    }
    const key = normalizeStorageKey(raw);
    if (key) keys.add(key);
  }

  for (const key of keys) {
    for (const root of roots) {
      const abs = resolve(join(root, key));
      if (isInside(root, abs)) diskTargets.add(abs);
    }
  }

  for (const abs of diskTargets) {
    if (!existsSync(abs)) continue;
    await unlink(abs);
    removed.push(abs);
  }

  if (isCloudStorage()) {
    for (const key of keys) {
      if (await deleteS3Object(key)) removed.push(`s3:${key}`);
    }
  }

  return removed;
}

/** Architecture summary for health checks and ops dashboards. */
export function getStorageArchitecture() {
  return {
    provider: getStorageProviderName(),
    cloud: isCloudStorage(),
    ephemeralHost: isEphemeralUploadHost(),
    durable: isCloudStorage() || !isEphemeralUploadHost(),
    bucket: isCloudStorage() ? process.env.S3_BUCKET || null : null,
    warning:
      !isCloudStorage() && isEphemeralUploadHost()
        ? 'Local disk on ephemeral host — set STORAGE_PROVIDER=s3 or documents will vanish after restart'
        : null,
  };
}
