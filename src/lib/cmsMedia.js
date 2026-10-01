import { getPool } from '../db/pool.js';
import { isIgnorableEnsureError } from '../db/schemaErrors.js';
import { newId } from './ids.js';

/**
 * CMS images (banner tiles) are stored in Postgres so they survive redeploys on
 * hosts with ephemeral disks (Render) regardless of STORAGE_PROVIDER.
 */

export const CMS_MEDIA_MAX_BYTES = Number(process.env.CMS_MEDIA_MAX_BYTES || 3 * 1024 * 1024);
export const CMS_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const MEDIA_URL_PREFIX = '/public/media/';
const MEDIA_ID_RE = /\/public\/media\/([0-9a-f-]{36})(?:[/?#]|$)/i;

let schemaReady = false;

export async function ensureCmsMediaSchema(pool = getPool()) {
  if (schemaReady) return;
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS cms_media (
        id CHAR(36) NOT NULL,
        purpose VARCHAR(64) NOT NULL DEFAULT 'general',
        file_name VARCHAR(255) NULL,
        mime_type VARCHAR(128) NOT NULL,
        size_bytes INT NOT NULL DEFAULT 0,
        data BYTEA NOT NULL,
        created_by CHAR(36) NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
    `);
  } catch (err) {
    if (!isIgnorableEnsureError(err)) throw err;
  }
  schemaReady = true;
}

export function cmsMediaUrl(id) {
  return `${MEDIA_URL_PREFIX}${id}`;
}

export function cmsMediaIdFromUrl(url) {
  const match = MEDIA_ID_RE.exec(String(url || ''));
  return match ? match[1].toLowerCase() : null;
}

export async function saveCmsImage({ buffer, mimeType, fileName, purpose = 'general', userId = null }) {
  if (!buffer?.length) {
    const err = new Error('Image file is empty');
    err.status = 400;
    throw err;
  }
  if (!CMS_IMAGE_MIME_TYPES.has(String(mimeType || '').toLowerCase())) {
    const err = new Error('Only JPG, PNG, WEBP or GIF images are allowed');
    err.status = 400;
    throw err;
  }
  if (buffer.length > CMS_MEDIA_MAX_BYTES) {
    const err = new Error(`Image must be ${Math.round(CMS_MEDIA_MAX_BYTES / (1024 * 1024))} MB or smaller`);
    err.status = 400;
    throw err;
  }
  const pool = getPool();
  await ensureCmsMediaSchema(pool);
  const id = newId();
  await pool.execute(
    `INSERT INTO cms_media (id, purpose, file_name, mime_type, size_bytes, data, created_by)
     VALUES (:id, :purpose, :file_name, :mime_type, :size_bytes, :data, :created_by)`,
    {
      id,
      purpose,
      file_name: String(fileName || '').slice(0, 255) || null,
      mime_type: String(mimeType).toLowerCase(),
      size_bytes: buffer.length,
      data: buffer,
      created_by: userId,
    },
  );
  return { id, url: cmsMediaUrl(id), mimeType, sizeBytes: buffer.length };
}

export async function getCmsMedia(id) {
  const pool = getPool();
  await ensureCmsMediaSchema(pool);
  const [[row]] = await pool.execute(
    `SELECT id, mime_type, size_bytes, data FROM cms_media WHERE id = :id LIMIT 1`,
    { id },
  );
  return row || null;
}

export async function deleteCmsMediaByUrl(url) {
  const id = cmsMediaIdFromUrl(url);
  if (!id) return false;
  const pool = getPool();
  await ensureCmsMediaSchema(pool);
  const [result] = await pool.execute(`DELETE FROM cms_media WHERE id = :id`, { id });
  return Number(result?.affectedRows || 0) > 0;
}
