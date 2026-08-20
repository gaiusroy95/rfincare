import { getStorageProviderName, isCloudStorage } from "./config.js";
import {
  getLocalObjectStream,
  getLocalPublicUrl,
  localObjectExists,
  putLocalObject
} from "./localProvider.js";
import {
  getS3ObjectStream,
  getS3SignedUrl,
  putS3Object,
  s3ObjectExists
} from "./s3Provider.js";
import { normalizeStorageKey, toStoredPath } from "./keys.js";
import { getStorageProviderName as getStorageProviderName2, isCloudStorage as isCloudStorage2, getS3Config } from "./config.js";
import { normalizeStorageKey as normalizeStorageKey2, toStoredPath as toStoredPath2, buildObjectKey, sanitizeFileName } from "./keys.js";
async function saveUploadedFile({ buffer, originalName, folder = "", mimeType }) {
  if (!buffer?.length) {
    throw new Error("Cannot save empty upload");
  }
  if (isCloudStorage()) {
    return putS3Object({ buffer, originalName, folder, mimeType });
  }
  return putLocalObject({ buffer, originalName, folder, mimeType });
}
async function openStoredFile(storedPath) {
  const key = normalizeStorageKey(storedPath);
  if (!key) return null;
  if (isCloudStorage()) {
    return getS3ObjectStream(key);
  }
  return getLocalObjectStream(key);
}
async function getStoredPublicUrl(storedPath) {
  const key = normalizeStorageKey(storedPath);
  if (!key) return null;
  if (isCloudStorage()) {
    const signed = await getS3SignedUrl(key);
    return signed || null;
  }
  return getLocalPublicUrl(key);
}
async function storedFileExists(storedPath) {
  const key = normalizeStorageKey(storedPath);
  if (!key) return false;
  if (isCloudStorage()) {
    return s3ObjectExists(key);
  }
  return localObjectExists(key);
}
function getStorageArchitecture() {
  return {
    provider: getStorageProviderName(),
    cloud: isCloudStorage(),
    bucket: isCloudStorage() ? process.env.S3_BUCKET || null : null
  };
}
export {
  buildObjectKey,
  getS3Config,
  getStorageArchitecture,
  getStorageProviderName2 as getStorageProviderName,
  getStoredPublicUrl,
  isCloudStorage2 as isCloudStorage,
  normalizeStorageKey2 as normalizeStorageKey,
  openStoredFile,
  sanitizeFileName,
  saveUploadedFile,
  storedFileExists,
  toStoredPath2 as toStoredPath
};
