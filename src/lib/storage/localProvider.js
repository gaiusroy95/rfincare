import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getUploadDir } from '../uploadPaths.js';
import { buildObjectKey, normalizeStorageKey } from './keys.js';

function resolveLocalPath(objectKey) {
  const key = normalizeStorageKey(objectKey);
  if (!key) return null;
  return join(getUploadDir(), key);
}

export async function putLocalObject({ buffer, originalName, folder = '', mimeType }) {
  const key = buildObjectKey(originalName, folder);
  const fullPath = resolveLocalPath(key);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, buffer);
  return {
    key,
    storedPath: `/uploads/${key}`,
    publicUrl: `/uploads/${encodeURIComponent(key).replace(/%2F/g, '/')}`,
    mimeType: mimeType || 'application/octet-stream',
  };
}

export async function getLocalObjectStream(objectKey) {
  const fullPath = resolveLocalPath(objectKey);
  if (!fullPath || !existsSync(fullPath)) return null;
  return {
    stream: createReadStream(fullPath),
    contentType: 'application/octet-stream',
  };
}

export function getLocalPublicUrl(objectKey) {
  const key = normalizeStorageKey(objectKey);
  if (!key) return null;
  return `/uploads/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export function localObjectExists(objectKey) {
  const fullPath = resolveLocalPath(objectKey);
  return Boolean(fullPath && existsSync(fullPath));
}
