import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeStorageKey, openStoredFile, storedFileExists } from './storage/index.js';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Same default upload directory as `app.js` static `/uploads` (local provider only). */
export function getUploadDir() {
  if (process.env.UPLOAD_DIR) {
    return resolve(process.env.UPLOAD_DIR);
  }
  return resolve(backendRoot, 'uploads');
}

/** Normalize DB-stored paths to a bare filename when possible (legacy helpers). */
export function normalizeStoredUploadName(storedPath) {
  const key = normalizeStorageKey(storedPath);
  if (!key) return null;
  return basename(key);
}

/** Resolve a stored path from DB to an existing file on disk (local provider). */
export function resolveUploadFilePath(storedPath, extraNames = []) {
  if (!storedPath && !extraNames.length) return null;

  const uploadDir = getUploadDir();
  const names = new Set();
  for (const value of [storedPath, ...extraNames]) {
    const normalized = normalizeStoredUploadName(value);
    if (normalized) names.add(normalized);
    const key = normalizeStorageKey(value);
    if (key) names.add(basename(key));
  }

  const candidates = [];
  if (storedPath) {
    candidates.push(storedPath, resolve(storedPath));
    const trimmed = String(storedPath).trim();
    if (trimmed.startsWith('/uploads/')) {
      const relative = trimmed.replace(/^\/uploads\//i, '').replace(/\\/g, '/');
      candidates.push(join(uploadDir, relative), join(uploadDir, basename(trimmed)));
    }
    const key = normalizeStorageKey(storedPath);
    if (key) candidates.push(join(uploadDir, key));
  }
  for (const name of names) {
    candidates.push(
      join(uploadDir, name),
      join(uploadDir, 'commission-circulars', name),
      join(uploadDir, 'agent-learning', name),
      join(uploadDir, 'staff-learning', name),
      join(backendRoot, 'uploads', name),
      join(backendRoot, 'uploads', 'commission-circulars', name),
      join(process.cwd(), 'uploads', name),
      join(process.cwd(), 'backend', 'uploads', name),
    );
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Stream a stored upload from local disk or cloud object storage. */
export async function streamStoredUpload(storedPath, extraNames = []) {
  const keys = new Set();
  for (const value of [storedPath, ...extraNames]) {
    const key = normalizeStorageKey(value);
    if (key) keys.add(key);
  }

  for (const key of keys) {
    const opened = await openStoredFile(key);
    if (opened?.stream) return opened;
  }

  const localPath = resolveUploadFilePath(storedPath, extraNames);
  if (!localPath) return null;

  const { createReadStream } = await import('node:fs');
  return {
    stream: createReadStream(localPath),
    contentType: 'application/octet-stream',
  };
}

/** Whether a stored upload exists in the active storage provider. */
export async function uploadExists(storedPath, extraNames = []) {
  const keys = new Set();
  for (const value of [storedPath, ...extraNames]) {
    const key = normalizeStorageKey(value);
    if (key) keys.add(key);
  }
  for (const key of keys) {
    if (await storedFileExists(key)) return true;
  }
  return Boolean(resolveUploadFilePath(storedPath, extraNames));
}
