import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assertS3Config } from './config.js';
import { buildObjectKey, normalizeStorageKey } from './keys.js';

let client;

function getClient() {
  if (client) return client;
  const cfg = assertS3Config();
  client = new S3Client({
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
  });
  return client;
}

function publicUrlForKey(key) {
  const cfg = assertS3Config();
  if (cfg.publicBaseUrl) {
    return `${cfg.publicBaseUrl.replace(/\/$/, '')}/${key}`;
  }
  if (cfg.endpoint && cfg.forcePathStyle) {
    const base = cfg.endpoint.replace(/\/$/, '');
    return `${base}/${cfg.bucket}/${key}`;
  }
  return `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com/${key}`;
}

export async function putS3Object({ buffer, originalName, folder = '', mimeType }) {
  const cfg = assertS3Config();
  const key = buildObjectKey(originalName, folder);
  await getClient().send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType || 'application/octet-stream',
    }),
  );
  return {
    key,
    storedPath: `/uploads/${key}`,
    publicUrl: publicUrlForKey(key),
    mimeType: mimeType || 'application/octet-stream',
  };
}

export async function getS3ObjectStream(objectKey) {
  const cfg = assertS3Config();
  const key = normalizeStorageKey(objectKey);
  if (!key) return null;
  try {
    const response = await getClient().send(
      new GetObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
      }),
    );
    return {
      stream: response.Body,
      contentType: response.ContentType || 'application/octet-stream',
    };
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

export async function getS3SignedUrl(objectKey) {
  const cfg = assertS3Config();
  const key = normalizeStorageKey(objectKey);
  if (!key) return null;
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: cfg.bucket, Key: key }),
    { expiresIn: cfg.signedUrlTtlSeconds },
  );
}

export async function s3ObjectExists(objectKey) {
  const cfg = assertS3Config();
  const key = normalizeStorageKey(objectKey);
  if (!key) return false;
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
    return true;
  } catch (err) {
    if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}
