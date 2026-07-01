import multer from 'multer';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { getUploadDir } from './uploadPaths.js';
import { isCloudStorage } from './storage/index.js';
import { buildObjectKey } from './storage/keys.js';
import { saveUploadedFile } from './storage/index.js';

const DEFAULT_MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 25 * 1024 * 1024);

function ensureLocalDir(subfolder = '') {
  const dir = subfolder ? join(getUploadDir(), subfolder) : getUploadDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

function diskStorageFor(subfolder = '') {
  return multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        cb(null, ensureLocalDir(subfolder));
      } catch (err) {
        cb(err);
      }
    },
    filename: (_req, file, cb) => {
      cb(null, buildObjectKey(file.originalname || 'file'));
    },
  });
}

/**
 *  multer runs, persist memory buffer to object storage and
 * attach legacy multer fields (`filename`, `path`) for existing route handlers.
 */
export function persistCloudUpload(subfolder = '') {
  return async (req, _res, next) => {
    try {
      const files = [];
      if (req.file) files.push(req.file);
      if (Array.isArray(req.files)) files.push(...req.files);
      else if (req.files && typeof req.files === 'object') {
        for (const group of Object.values(req.files)) {
          if (Array.isArray(group)) files.push(...group);
        }
      }

      for (const file of files) {
        if (!file?.buffer) continue;
        const saved = await saveUploadedFile({
          buffer: file.buffer,
          originalName: file.originalname,
          folder: subfolder,
          mimeType: file.mimetype,
        });
        file.filename = saved.key;
        file.path = saved.storedPath;
        file.storageKey = saved.key;
        file.storedPath = saved.storedPath;
        file.publicUrl = saved.publicUrl;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Drop-in multer factory for all upload routes.
 * Local dev uses disk; production cloud uses memory + S3-compatible storage.
 */
export function createUploadMiddleware({
  subfolder = '',
  maxBytes = DEFAULT_MAX_BYTES,
  fileFilter,
} = {}) {
  const limits = { fileSize: maxBytes };
  const options = fileFilter ? { limits, fileFilter } : { limits };

  if (isCloudStorage()) {
    const memory = multer({ storage: multer.memoryStorage(), ...options });
    return {
      single: (field) => [memory.single(field), persistCloudUpload(subfolder)],
      array: (field, maxCount) => [memory.array(field, maxCount), persistCloudUpload(subfolder)],
      fields: (fields) => [memory.fields(fields), persistCloudUpload(subfolder)],
    };
  }

  const disk = multer({ storage: diskStorageFor(subfolder), ...options });
  return {
    single: (field) => disk.single(field),
    array: (field, maxCount) => disk.array(field, maxCount),
    fields: (fields) => disk.fields(fields),
  };
}

/** Run multer middleware chain from createUploadMiddleware (disk or cloud). */
export function spreadUpload(uploadFactory, method, ...args) {
  const chain = uploadFactory[method](...args);
  return Array.isArray(chain) ? chain : [chain];
}
