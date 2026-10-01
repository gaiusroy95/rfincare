import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getUploadDir, normalizeStoredUploadName, resolveUploadFilePath } from './uploadPaths.js';
import { deleteStoredFile } from './storage/index.js';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const assetsRoot = resolve(backendRoot, 'assets');

const UPLOAD_SUBDIRS = ['commission-circulars', 'agent-learning', 'staff-learning'];

/** Turn legacy bare filenames into /uploads/... paths when possible. */
export function normalizeLearningPublicUrl(fileUrl) {
  if (!fileUrl) return null;
  const trimmed = String(fileUrl).trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/uploads/')) return trimmed;

  const name = basename(trimmed.replace(/^\/+/, ''));
  if (!name) return null;

  const diskPath = resolveLearningDiskPath({ fileUrl: trimmed, fileName: name });
  if (diskPath) {
    const uploadDir = getUploadDir();
    const relative = diskPath.slice(uploadDir.length).replace(/\\/g, '/').replace(/^\/+/, '');
    return `/uploads/${relative}`;
  }

  return `/uploads/commission-circulars/${name}`;
}

export function buildAgentCircularDownloadPath(circularId) {
  const id = String(circularId || '').replace(/^circular-/, '');
  return `/portal/agent/learning/circulars/${encodeURIComponent(id)}/file`;
}

export function buildAgentContentDownloadPath(contentId) {
  return `/portal/agent/learning/content/${encodeURIComponent(contentId)}/file`;
}

export function buildEmployeeContentDownloadPath(contentId) {
  return `/portal/employee/learning/content/${encodeURIComponent(contentId)}/file`;
}

function findFileInUploadSubdirs(fileName) {
  if (!fileName) return null;
  const uploadDir = getUploadDir();
  const lower = fileName.toLowerCase();

  const searchDirs = [
    ...UPLOAD_SUBDIRS.map((subdir) => join(uploadDir, subdir)),
    ...UPLOAD_SUBDIRS.map((subdir) => join(assetsRoot, subdir)),
  ];

  for (const dirPath of searchDirs) {
    if (!existsSync(dirPath)) continue;
    try {
      for (const entry of readdirSync(dirPath)) {
        if (
          entry === fileName
          || entry.toLowerCase() === lower
          || entry.toLowerCase().endsWith(`-${lower}`)
        ) {
          const full = join(dirPath, entry);
          if (existsSync(full)) return full;
        }
      }
    } catch {
      /* ignore unreadable dirs */
    }
  }
  return null;
}

/** Resolve a learning/circular asset to an absolute path on disk. */
export function resolveLearningDiskPath({ filePath, fileUrl, fileName } = {}) {
  const names = [
    fileName,
    normalizeStoredUploadName(filePath),
    normalizeStoredUploadName(fileUrl),
  ].filter(Boolean);

  for (const name of names) {
    const found = findFileInUploadSubdirs(name);
    if (found) return found;
  }

  const fromPath = resolveUploadFilePath(filePath, names);
  if (fromPath) return fromPath;

  const fromUrl = resolveUploadFilePath(fileUrl, names);
  if (fromUrl) return fromUrl;

  return null;
}

function buildPublicUploadUrl(diskPath) {
  const uploadDir = getUploadDir();
  if (!diskPath.startsWith(uploadDir)) return null;
  const relative = diskPath.slice(uploadDir.length).replace(/\\/g, '/').replace(/^\/+/, '');
  return `/uploads/${relative}`;
}

export function resolveLearningOpenTarget({
  id,
  contentType,
  videoUrl,
  fileUrl,
  filePath,
  fileName,
  legacy = false,
  portal = 'agent',
}) {
  if (videoUrl && /^https?:\/\//i.test(videoUrl)) {
    return { openUrl: videoUrl, downloadPath: null };
  }

  if (legacy && id) {
    const circularId = String(id).replace(/^circular-/, '');
    const downloadPath = buildAgentCircularDownloadPath(circularId);
    return { openUrl: downloadPath, downloadPath };
  }

  if (id && (fileUrl || filePath || fileName || contentType === 'video' || contentType === 'marketing' || contentType === 'image')) {
    const downloadPath =
      portal === 'employee'
        ? buildEmployeeContentDownloadPath(id)
        : buildAgentContentDownloadPath(id);
    return { openUrl: downloadPath, downloadPath };
  }

  if (fileUrl || filePath || fileName) {
    const diskPath = resolveLearningDiskPath({ filePath, fileUrl, fileName });
    const publicUrl = diskPath
      ? buildPublicUploadUrl(diskPath)
      : normalizeLearningPublicUrl(fileUrl || filePath || fileName);
    if (publicUrl) return { openUrl: publicUrl, downloadPath: publicUrl };
  }

  if (videoUrl) return { openUrl: videoUrl, downloadPath: null };
  return { openUrl: null, downloadPath: null };
}

/**
 * Permanently delete a learning item: its stored file + thumbnail, all progress rows,
 * then the content row. Files are deleted first so a storage failure leaves the row
 * in place for a retry instead of orphaning the file.
 * @returns {Promise<{ filesRemoved: string[] }>}
 */
export async function deleteLearningContent(pool, row) {
  const groups = [[row.file_url, row.file_path]];
  if (row.thumbnail_url && row.thumbnail_url !== row.file_url) groups.push([row.thumbnail_url]);

  const filesRemoved = [];
  for (const group of groups) {
    const url = group.find(Boolean);
    if (!url) continue;
    const [[shared]] = await pool.execute(
      `SELECT COUNT(*) AS n FROM agent_learning_content
       WHERE id <> :id AND (file_url = :url OR thumbnail_url = :url)`,
      { id: row.id, url },
    );
    if (Number(shared?.n || 0) > 0) continue;
    filesRemoved.push(...(await deleteStoredFile(...group)));
  }

  await pool.execute(`DELETE FROM agent_learning_progress WHERE content_id = :id`, { id: row.id });
  await pool.execute(`DELETE FROM employee_learning_progress WHERE content_id = :id`, { id: row.id });
  await pool.execute(`DELETE FROM agent_learning_content WHERE id = :id`, { id: row.id });

  return { filesRemoved };
}

export function buildConfigCircularId(fileUrl) {
  return `cfg-${Buffer.from(String(fileUrl)).toString('base64url').slice(0, 12)}`;
}
