function getStorageProviderName() {
  const raw = String(process.env.STORAGE_PROVIDER || "").trim().toLowerCase();
  const cfg = getS3Config();
  const s3Ready = Boolean(cfg.bucket && cfg.accessKeyId && cfg.secretAccessKey);
  if (raw === "s3") return "s3";
  if (raw === "local") {
    if (s3Ready && process.env.FORCE_LOCAL_STORAGE !== "true") {
      console.warn(
        "[storage] STORAGE_PROVIDER=local but S3 credentials are set — using s3 so uploads survive deploys"
      );
      return "s3";
    }
    return "local";
  }
  return s3Ready ? "s3" : "local";
}
function isCloudStorage() {
  return getStorageProviderName() === "s3";
}
function isEphemeralUploadHost() {
  return Boolean(
    process.env.K_SERVICE || process.env.CLOUD_RUN_JOB || process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME
  );
}
function getS3Config() {
  return {
    bucket: process.env.S3_BUCKET || "",
    region: process.env.S3_REGION || "us-east-1",
    accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
    endpoint: process.env.S3_ENDPOINT || void 0,
    forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || "false").toLowerCase() === "true",
    publicBaseUrl: process.env.S3_PUBLIC_URL || "",
    signedUrlTtlSeconds: Number(process.env.S3_SIGNED_URL_TTL_SECONDS || 3600)
  };
}
function assertS3Config() {
  const cfg = getS3Config();
  if (!cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
    throw new Error(
      "STORAGE_PROVIDER=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY"
    );
  }
  return cfg;
}
export {
  assertS3Config,
  getS3Config,
  getStorageProviderName,
  isCloudStorage,
  isEphemeralUploadHost
};
