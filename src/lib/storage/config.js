/** @typedef {'local' | 's3'} StorageProviderName */

/**
 * Object storage provider for uploaded files (documents, logos, learning assets).
 * - local: filesystem under UPLOAD_DIR (default for local dev only)
 * - s3: S3-compatible API (AWS S3, GCS HMAC, Supabase Storage, R2, MinIO)
 *
 * If S3 credentials are present, prefer s3 even when STORAGE_PROVIDER=local
 * (safety net for Cloud Run / Render misconfiguration).
 */
export function getStorageProviderName() {
  const raw = String(process.env.STORAGE_PROVIDER || '').trim().toLowerCase();
  const cfg = getS3Config();
  const s3Ready = Boolean(cfg.bucket && cfg.accessKeyId && cfg.secretAccessKey);

  if (raw === 's3') return 's3';
  if (raw === 'local') {
    if (s3Ready && process.env.FORCE_LOCAL_STORAGE !== 'true') {
      // eslint-disable-next-line no-console
      console.warn(
        '[storage] STORAGE_PROVIDER=local but S3 credentials are set — using s3 so uploads survive deploys',
      );
      return 's3';
    }
    return 'local';
  }

  // Default: s3 when configured, otherwise local (dev)
  return s3Ready ? 's3' : 'local';
}

export function isCloudStorage() {
  return getStorageProviderName() === 's3';
}

/** True when the host filesystem is expected to be ephemeral (Cloud Run, Render, Railway). */
export function isEphemeralUploadHost() {
  return Boolean(
    process.env.K_SERVICE
    || process.env.CLOUD_RUN_JOB
    || process.env.RENDER
    || process.env.RAILWAY_ENVIRONMENT
    || process.env.FLY_APP_NAME,
  );
}

export function getS3Config() {
  return {
    bucket: process.env.S3_BUCKET || '',
    region: process.env.S3_REGION || 'us-east-1',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || 'false').toLowerCase() === 'true',
    publicBaseUrl: process.env.S3_PUBLIC_URL || '',
    signedUrlTtlSeconds: Number(process.env.S3_SIGNED_URL_TTL_SECONDS || 3600),
  };
}

export function assertS3Config() {
  const cfg = getS3Config();
  if (!cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
    throw new Error(
      'STORAGE_PROVIDER=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY',
    );
  }
  return cfg;
}
