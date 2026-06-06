import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Same default upload directory as `app.js` static `/uploads`. */
export function getUploadDir() {
  if (process.env.UPLOAD_DIR) {
    return resolve(process.env.UPLOAD_DIR);
  }
  return resolve(backendRoot, 'uploads');
}

/** Normalize DB-stored paths to a bare filename when possible. */
export function normalizeStoredUploadName(storedPath) {
  if (!storedPath) return null;
  const trimmed = String(storedPath).trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return null;
  const withoutUploadsPrefix = trimmed.replace(/^\/uploads\//i, '').replace(/^uploads[\\/]/i, '');
  return basename(withoutUploadsPrefix);
}

/** Resolve a stored path from DB to an existing file on disk. */
export function resolveUploadFilePath(storedPath, extraNames = []) {
  if (!storedPath && !extraNames.length) return null;

  const uploadDir = getUploadDir();
  const names = new Set();
  for (const value of [storedPath, ...extraNames]) {
    const normalized = normalizeStoredUploadName(value);
    if (normalized) names.add(normalized);
  }

  const candidates = [];
  if (storedPath) {
    candidates.push(storedPath, resolve(storedPath));
    const trimmed = String(storedPath).trim();
    if (trimmed.startsWith('/uploads/')) {
      candidates.push(join(uploadDir, basename(trimmed)));
    }
  }
  for (const name of names) {
    candidates.push(
      join(uploadDir, name),
      join(backendRoot, 'uploads', name),
      join(process.cwd(), 'uploads', name),
      join(process.cwd(), 'backend', 'uploads', name),
    );
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}
