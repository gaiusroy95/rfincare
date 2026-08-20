function getStorageProviderName() {
  const raw = String(process.env.STORAGE_PROVIDER || "local").trim().toLowerCase();
  return raw === "s3" ? "s3" : "local";
}
function isCloudStorage() {
  return getStorageProviderName() === "s3";
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
  isCloudStorage
};
