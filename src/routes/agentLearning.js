import { Router } from 'express';
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { newId } from '../lib/ids.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { ensureAgentLearningSchema } from '../db/ensureAgentLearningSchema.js';
import { fetchAgentCommissionCirculars } from '../lib/agentCommission.js';
import {
  buildConfigCircularId,
  resolveLearningDiskPath,
  resolveLearningOpenTarget,
} from '../lib/learningFileDelivery.js';

export const adminAgentLearningRouter = Router();
export const portalAgentLearningRouter = Router();

const CONTENT_TYPES = new Set([
  'video',
  'pdf',
  'presentation',
  'circular',
  'course',
  'webinar',
  'certification',
]);

const TRAINING_TYPE_MAP = {
  video: 'video',
  pdf: 'document',
  presentation: 'document',
  circular: 'document',
  course: 'course',
  webinar: 'webinar',
  certification: 'certification',
};

const uploadRoot = process.env.UPLOAD_DIR || './uploads';
const learningDir = resolve(uploadRoot, 'agent-learning');
mkdirSync(learningDir, { recursive: true });

const learningUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, learningDir),
    filename: (_req, file, cb) => {
      const safe = `${Date.now()}-${Math.random().toString(36).slice(2)}${extname(file.originalname)}`;
      cb(null, safe);
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
});

function formatContentRow(row, progress = null) {
  const progressPercent = progress?.progress_percent ?? 0;
  const { openUrl } = resolveLearningOpenTarget({
    id: row.id,
    contentType: row.content_type,
    videoUrl: row.video_url,
    fileUrl: row.file_url,
    filePath: row.file_path,
    fileName: row.file_name,
  });
  return {
    id: row.id,
    contentType: row.content_type,
    type: TRAINING_TYPE_MAP[row.content_type] || 'document',
    title: row.title,
    description: row.description,
    duration: row.duration_label || '',
    durationLabel: row.duration_label,
    fileName: row.file_name,
    fileUrl: row.file_url,
    videoUrl: row.video_url,
    mimeType: row.mime_type,
    isNew: Boolean(row.is_new),
    isActive: Boolean(row.is_active),
    sortOrder: row.sort_order,
    progress: progressPercent,
    completedAt: progress?.completed_at || null,
    createdAt: row.created_at,
    openUrl,
  };
}

async function fetchLearningForAgent(pool, agentUserId) {
  await ensureAgentLearningSchema();
  const [rows] = await pool.execute(
    `SELECT c.*, p.progress_percent, p.completed_at
     FROM agent_learning_content c
     LEFT JOIN agent_learning_progress p
       ON p.content_id = c.id AND p.agent_user_id = :agentId
     WHERE c.is_active = TRUE AND c.audience IN ('agent', 'all')
     ORDER BY c.is_new DESC, c.sort_order ASC, c.created_at DESC`,
    { agentId: agentUserId },
  );
  return rows.map((r) =>
    formatContentRow(r, {
      progress_percent: r.progress_percent,
      completed_at: r.completed_at,
    }),
  );
}

/** Include legacy commission circulars in agent feed */
async function fetchLegacyCirculars(pool) {
  try {
    const rows = await fetchAgentCommissionCirculars(pool);
    return rows.map((r) => {
      const circularId = String(r.id).replace(/^circular-/, '');
      const { openUrl } = resolveLearningOpenTarget({
        id: circularId,
        contentType: 'circular',
        fileUrl: r.file_url,
        filePath: r.file_path,
        fileName: r.file_name,
        legacy: true,
      });
      return {
        id: `circular-${r.id}`,
        contentType: 'circular',
        type: 'document',
        title: r.title,
        description: r.description,
        duration: 'PDF',
        fileName: r.file_name,
        fileUrl: r.file_url,
        videoUrl: null,
        isNew: false,
        progress: 0,
        createdAt: r.created_at,
        openUrl,
        legacy: true,
      };
    });
  } catch {
    return [];
  }
}

// ——— Admin ———

adminAgentLearningRouter.get(
  '/',
  authenticate,
  authorize({ resource: 'agents', action: 'read' }),
  async (_req, res, next) => {
    try {
      await ensureAgentLearningSchema();
      const pool = getPool();
      const [rows] = await pool.execute(
        `SELECT * FROM agent_learning_content
         WHERE audience IN ('agent', 'all')
         ORDER BY sort_order ASC, created_at DESC`,
      );
      res.json(rows.map((r) => formatContentRow(r)));
    } catch (err) {
      next(err);
    }
  },
);

adminAgentLearningRouter.post(
  '/',
  authenticate,
  authorize({ resource: 'agents', action: 'update' }),
  learningUpload.single('file'),
  async (req, res, next) => {
    try {
      await ensureAgentLearningSchema();
      const contentType = String(req.body?.contentType || req.body?.content_type || 'pdf').toLowerCase();
      if (!CONTENT_TYPES.has(contentType)) {
        return res.status(400).json({ error: 'Invalid content type' });
      }

      const title = req.body?.title?.trim();
      if (!title) return res.status(400).json({ error: 'Title is required' });

      const videoUrl = req.body?.videoUrl?.trim() || req.body?.video_url?.trim() || null;
      if (contentType === 'video' && !videoUrl && !req.file) {
        return res.status(400).json({ error: 'Video URL or file is required for video content' });
      }
      if (contentType !== 'video' && !req.file && !videoUrl) {
        return res.status(400).json({ error: 'File upload is required' });
      }

      const id = newId();
      const pool = getPool();
      let fileUrl = null;
      let filePath = null;
      let fileName = null;
      let mimeType = null;

      if (req.file) {
        fileName = req.file.originalname;
        filePath = req.file.path;
        mimeType = req.file.mimetype;
        fileUrl = `/uploads/agent-learning/${req.file.filename}`;
      }

      await pool.execute(
        `INSERT INTO agent_learning_content
         (id, content_type, audience, title, description, category_label, duration_label, file_name, file_path, file_url, mime_type,
          video_url, is_new, sort_order, uploaded_by)
         VALUES
         (:id, :content_type, :audience, :title, :description, :category_label, :duration_label, :file_name, :file_path, :file_url, :mime_type,
          :video_url, :is_new, :sort_order, :uploaded_by)`,
        {
          id,
          content_type: contentType,
          audience: req.body?.audience === 'all' ? 'all' : 'agent',
          title,
          description: req.body?.description?.trim() || null,
          category_label: req.body?.categoryLabel?.trim() || req.body?.category_label?.trim() || null,
          duration_label: req.body?.durationLabel?.trim() || req.body?.duration_label?.trim() || null,
          file_name: fileName,
          file_path: filePath,
          file_url: fileUrl,
          mime_type: mimeType,
          video_url: videoUrl,
          is_new: req.body?.isNew === 'false' || req.body?.isNew === false ? 0 : 1,
          sort_order: Number.parseInt(req.body?.sortOrder ?? req.body?.sort_order ?? '0', 10) || 0,
          uploaded_by: req.auth.userId,
        },
      );

      const [[row]] = await pool.execute(`SELECT * FROM agent_learning_content WHERE id = :id`, { id });
      res.status(201).json(formatContentRow(row));
    } catch (err) {
      next(err);
    }
  },
);

const PatchLearningSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  durationLabel: z.string().optional(),
  videoUrl: z.string().optional(),
  isNew: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  contentType: z.string().optional(),
});

adminAgentLearningRouter.patch(
  '/:id',
  authenticate,
  authorize({ resource: 'agents', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureAgentLearningSchema();
      const input = PatchLearningSchema.parse(req.body);
      const pool = getPool();
      await pool.execute(
        `UPDATE agent_learning_content SET
          title = COALESCE(:title, title),
          description = COALESCE(:description, description),
          duration_label = COALESCE(:duration_label, duration_label),
          video_url = COALESCE(:video_url, video_url),
          is_new = COALESCE(:is_new, is_new),
          is_active = COALESCE(:is_active, is_active),
          sort_order = COALESCE(:sort_order, sort_order),
          content_type = COALESCE(:content_type, content_type)
         WHERE id = :id`,
        {
          id: req.params.id,
          title: input.title || null,
          description: input.description ?? null,
          duration_label: input.durationLabel ?? null,
          video_url: input.videoUrl ?? null,
          is_new: input.isNew == null ? null : input.isNew ? 1 : 0,
          is_active: input.isActive == null ? null : input.isActive ? 1 : 0,
          sort_order: input.sortOrder ?? null,
          content_type: input.contentType || null,
        },
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

adminAgentLearningRouter.delete(
  '/:id',
  authenticate,
  authorize({ resource: 'agents', action: 'update' }),
  async (req, res, next) => {
    try {
      await ensureAgentLearningSchema();
      const pool = getPool();
      await pool.execute(
        `UPDATE agent_learning_content SET is_active = FALSE WHERE id = :id`,
        { id: req.params.id },
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// ——— Agent portal ———

portalAgentLearningRouter.use(authenticate);

async function lookupCommissionCircular(pool, rawId) {
  const id = String(rawId || '').replace(/^circular-/, '');
  if (!id) return null;

  if (id.startsWith('cfg-')) {
    const [configRows] = await pool.execute(
      `SELECT circular_title, circular_file_url
       FROM agent_commission_config
       WHERE circular_file_url IS NOT NULL AND TRIM(circular_file_url) != ''`,
    );
    for (const cfg of configRows || []) {
      if (buildConfigCircularId(cfg.circular_file_url) !== id) continue;
      return {
        title: cfg.circular_title || 'Commission circular',
        file_name: cfg.circular_title || 'circular.pdf',
        file_path: cfg.circular_file_url,
        file_url: cfg.circular_file_url,
        mime_type: 'application/pdf',
      };
    }
    return null;
  }

  const [[row]] = await pool.execute(
    `SELECT title, file_name, file_path, file_url
     FROM agent_commission_circulars
     WHERE id = :id AND is_active = TRUE
     LIMIT 1`,
    { id },
  );
  if (!row) return null;
  return {
    title: row.title,
    file_name: row.file_name,
    file_path: row.file_path,
    file_url: row.file_url,
    mime_type: 'application/pdf',
  };
}

function sendLearningFile(res, record, next) {
  const diskPath = resolveLearningDiskPath({
    filePath: record.file_path,
    fileUrl: record.file_url,
    fileName: record.file_name,
  });
  if (!diskPath) {
    const err = new Error('Learning file not found on server');
    err.status = 404;
    return next(err);
  }
  res.setHeader('Content-Type', record.mime_type || 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${record.file_name || 'document.pdf'}"`);
  return res.sendFile(diskPath);
}

function assertAgentPortalAccess(req) {
  if (req.auth.role !== 'agent' && !['admin', 'super_admin'].includes(req.auth.role)) {
    const e = new Error('Agent access only');
    e.status = 403;
    throw e;
  }
}

portalAgentLearningRouter.get('/circulars/:id/file', async (req, res, next) => {
  try {
    assertAgentPortalAccess(req);
    const pool = getPool();
    const record = await lookupCommissionCircular(pool, req.params.id);
    if (!record) return res.status(404).json({ error: 'Circular not found' });
    return sendLearningFile(res, record, next);
  } catch (err) {
    next(err);
  }
});

portalAgentLearningRouter.get('/content/:id/file', async (req, res, next) => {
  try {
    assertAgentPortalAccess(req);
    await ensureAgentLearningSchema();
    const pool = getPool();
    const [[row]] = await pool.execute(
      `SELECT id, title, file_name, file_path, file_url, mime_type, content_type
       FROM agent_learning_content
       WHERE id = :id AND is_active = TRUE AND audience IN ('agent', 'all')
       LIMIT 1`,
      { id: req.params.id },
    );
    if (!row) return res.status(404).json({ error: 'Content not found' });
    return sendLearningFile(res, row, next);
  } catch (err) {
    next(err);
  }
});

portalAgentLearningRouter.get('/', async (req, res, next) => {
  try {
    assertAgentPortalAccess(req);
    const pool = getPool();
    const items = await fetchLearningForAgent(pool, req.auth.userId);
    const legacy = await fetchLegacyCirculars(pool);
    const seen = new Set(items.map((i) => i.title));
    const merged = [
      ...items,
      ...legacy.filter((l) => !seen.has(l.title)),
    ];
    res.json(merged);
  } catch (err) {
    next(err);
  }
});

portalAgentLearningRouter.post('/:id/progress', async (req, res, next) => {
  try {
    if (req.auth.role !== 'agent') {
      const e = new Error('Agent access only');
      e.status = 403;
      throw e;
    }
    if (String(req.params.id).startsWith('circular-')) {
      return res.json({ ok: true, progress: req.body?.progress ?? 100 });
    }

    const progress = Math.min(100, Math.max(0, Number.parseInt(req.body?.progress ?? 0, 10) || 0));
    await ensureAgentLearningSchema();
    const pool = getPool();
    const contentId = req.params.id;

    const [[content]] = await pool.execute(
      `SELECT id FROM agent_learning_content WHERE id = :id AND is_active = TRUE AND audience IN ('agent', 'all') LIMIT 1`,
      { id: contentId },
    );
    if (!content) return res.status(404).json({ error: 'Content not found' });

    const progressId = newId();
    await pool.execute(
      `INSERT INTO agent_learning_progress (id, agent_user_id, content_id, progress_percent, completed_at)
       VALUES (:id, :agent_id, :content_id, :progress, :completed_at)
       ON CONFLICT (agent_user_id, content_id) DO UPDATE SET progress_percent = EXCLUDED.progress_percent,
         completed_at = EXCLUDED.completed_at,
         updated_at = NOW()`,
      {
        id: progressId,
        agent_id: req.auth.userId,
        content_id: contentId,
        progress,
        completed_at: progress >= 100 ? new Date() : null,
      },
    );

    res.json({ ok: true, progress });
  } catch (err) {
    next(err);
  }
});

export async function getAgentLearningFeed(pool, agentUserId) {
  const items = await fetchLearningForAgent(pool, agentUserId);
  const legacy = await fetchLegacyCirculars(pool);
  const seen = new Set(items.map((i) => i.title));
  return [...items, ...legacy.filter((l) => !seen.has(l.title))];
}