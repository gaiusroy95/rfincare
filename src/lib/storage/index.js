import { getStorageProviderName, isCloudStorage, isEphemeralUploadHost } from './config.js';
import {
  getLocalObjectStream,
  getLocalPublicUrl,
  localObjectExists,
  putLocalObject,
} from './localProvider.js';
import {
  getS3ObjectStream,
  getS3SignedUrl,
  putS3Object,
  s3ObjectExists,
} from './s3Provider.js';
import { normalizeStorageKey, toStoredPath } from './keys.js';

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
