import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getUploadDir, normalizeStoredUploadName, resolveUploadFilePath } from './uploadPaths.js';

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
    const diskPath = resolveLearningDiskPath({ filePath, fileUrl, fileName });
    const publicUrl = diskPath ? buildPublicUploadUrl(diskPath) : null;
    if (publicUrl) {
      return { openUrl: publicUrl, downloadPath: publicUrl };
    }
    const circularId = String(id).replace(/^circular-/, '');
    return {
      openUrl: buildAgentCircularDownloadPath(circularId),
      downloadPath: buildAgentCircularDownloadPath(circularId),
    };
  }

  if (fileUrl || filePath || fileName) {
    const diskPath = resolveLearningDiskPath({ filePath, fileUrl, fileName });
    const publicUrl = diskPath ? buildPublicUploadUrl(diskPath) : normalizeLearningPublicUrl(fileUrl || filePath || fileName);
    if (diskPath && publicUrl?.startsWith('/uploads/')) {
      return { openUrl: publicUrl, downloadPath: publicUrl };
    }
    if (id && contentType !== 'video') {
      const downloadPath =
        portal === 'employee'
          ? buildEmployeeContentDownloadPath(id)
          : buildAgentContentDownloadPath(id);
      return {
        openUrl: downloadPath,
        downloadPath,
      };
    }
    if (publicUrl) return { openUrl: publicUrl, downloadPath: publicUrl };
  }

  if (videoUrl) return { openUrl: videoUrl, downloadPath: null };
  return { openUrl: null, downloadPath: null };
}

export function buildConfigCircularId(fileUrl) {
  return `cfg-${Buffer.from(String(fileUrl)).toString('base64url').slice(0, 12)}`;
}
