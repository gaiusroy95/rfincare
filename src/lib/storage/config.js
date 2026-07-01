/** @typedef {'local' | 's3'} StorageProviderName */

/**
 * Object storage provider for uploaded files (documents, logos, learning assets).
 * - local: filesystem under UPLOAD_DIR (default for local dev)
 * - s3: S3-compatible API (AWS S3, Supabase Storage, Neon/R2, MinIO)
 */
export function getStorageProviderName() {
  const raw = String(process.env.STORAGE_PROVIDER || 'local').trim().toLowerCase();
  return raw === 's3' ? 's3' : 'local';
}

export function isCloudStorage() {
  return getStorageProviderName() === 's3';
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
