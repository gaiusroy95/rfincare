import { Router } from 'express';
import multer from 'multer';

import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import {
  parsePolicyWorkbook,
  buildImportPreview,
  saveValidatedImportJob,
  commitImportJob,
  listImportJobs,
  getImportJob,
  getTemplateBuffer,
  buildErrorReportCsv,
} from '../lib/lenderPolicyBulkImport.js';

export const lenderPolicyImportRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || '').toLowerCase();
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      cb(null, true);
      return;
    }
    cb(new Error('Only Excel .xlsx files are accepted'));
  },
});

function wrapMulter(mw) {
  return (req, res, next) => {
    mw(req, res, (err) => {
      if (err) {
        err.status = 400;
        next(err);
        return;
      }
      next();
    });
  };
}

lenderPolicyImportRouter.get(
  '/template',
  authenticate,
  authorize({ resource: 'banks', action: 'read' }),
  async (_req, res, next) => {
    try {
      const { buffer } = getTemplateBuffer();
      if (!buffer?.length) {
        const err = new Error('Template workbook could not be built');
        err.status = 500;
        throw err;
      }
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="loan-advisory-lender-product-bulk-upload.xlsx"',
      );
      res.setHeader('Cache-Control', 'no-store');
      res.send(Buffer.from(buffer));
    } catch (err) {
      next(err);
    }
  },
);

lenderPolicyImportRouter.get(
  '/jobs',
  authenticate,
  authorize({ resource: 'banks', action: 'read' }),
  async (req, res, next) => {
    try {
      const rows = await listImportJobs(Number(req.query.limit) || 30);
      res.json(
        rows.map((row) => ({
          id: row.id,
          fileName: row.file_name,
          status: row.status,
          summary:
            typeof row.summary_json === 'string'
              ? JSON.parse(row.summary_json)
              : row.summary_json,
          unsupportedSheets:
            typeof row.unsupported_sheets_json === 'string'
              ? JSON.parse(row.unsupported_sheets_json)
              : row.unsupported_sheets_json,
          createdBy: row.created_by,
          committedBy: row.committed_by,
          committedAt: row.committed_at,
          createdAt: row.created_at,
        })),
      );
    } catch (err) {
      next(err);
    }
  },
);

lenderPolicyImportRouter.get(
  '/jobs/:id',
  authenticate,
  authorize({ resource: 'banks', action: 'read' }),
  async (req, res, next) => {
    try {
      const row = await getImportJob(req.params.id);
      if (!row) return res.status(404).json({ error: 'Import job not found' });
      const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
      res.json({
        id: row.id,
        fileName: row.file_name,
        status: row.status,
        summary: parse(row.summary_json),
        preview: parse(row.preview_json),
        unsupportedSheets: parse(row.unsupported_sheets_json),
        errorReport: parse(row.error_report_json),
        commitResult: parse(row.commit_result_json),
        createdBy: row.created_by,
        committedBy: row.committed_by,
        committedAt: row.committed_at,
        createdAt: row.created_at,
      });
    } catch (err) {
      next(err);
    }
  },
);

lenderPolicyImportRouter.post(
  '/validate',
  authenticate,
  authorize({ resource: 'banks', action: 'manage' }),
  wrapMulter(upload.single('file')),
  async (req, res, next) => {
    try {
      if (!req.file?.buffer?.length) {
        return res.status(400).json({ error: 'Excel file is required (field name: file)' });
      }
      const parsed = parsePolicyWorkbook(req.file.buffer);
      const preview = buildImportPreview(parsed);
      const jobId = await saveValidatedImportJob({
        fileName: req.file.originalname,
        parsed,
        preview,
        createdBy: req.auth.userId,
      });
      res.json({
        jobId,
        valid: preview.valid,
        preview,
      });
    } catch (err) {
      next(err);
    }
  },
);

lenderPolicyImportRouter.get(
  '/jobs/:id/error-report',
  authenticate,
  authorize({ resource: 'banks', action: 'read' }),
  async (req, res, next) => {
    try {
      const row = await getImportJob(req.params.id);
      if (!row) return res.status(404).json({ error: 'Import job not found' });
      const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
      const errorReport = parse(row.error_report_json) || { errors: [], warnings: [] };
      const format = String(req.query.format || 'csv').toLowerCase();
      if (format === 'json') {
        return res.json(errorReport);
      }
      const csv = buildErrorReportCsv(errorReport);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="lender-policy-import-${req.params.id.slice(0, 8)}-errors.csv"`,
      );
      res.send(csv);
    } catch (err) {
      next(err);
    }
  },
);

lenderPolicyImportRouter.post(
  '/jobs/:id/approve',
  authenticate,
  authorize({ resource: 'banks', action: 'manage' }),
  async (req, res, next) => {
    try {
      const job = await getImportJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'Import job not found' });
      if (job.status === 'invalid') {
        return res.status(400).json({ error: 'Cannot approve an invalid import' });
      }
      if (job.status === 'committed') {
        return res.status(409).json({ error: 'Import already committed' });
      }
      const pool = (await import('../db/pool.js')).getPool();
      await pool.execute(
        `UPDATE lender_policy_import_jobs SET
           status = 'approved',
           updated_at = NOW()
         WHERE id = :id`,
        { id: req.params.id },
      );
      res.json({ success: true, status: 'approved', jobId: req.params.id });
    } catch (err) {
      next(err);
    }
  },
);

lenderPolicyImportRouter.post(
  '/jobs/:id/commit',
  authenticate,
  authorize({ resource: 'banks', action: 'manage' }),
  async (req, res, next) => {
    try {
      const job = await getImportJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'Import job not found' });
      if (job.status === 'validated') {
        return res.status(400).json({
          error: 'Approve the import before publishing (Upload → Validate → Preview → Approve → Publish).',
        });
      }
      if (job.status !== 'approved' && job.status !== 'committed') {
        return res.status(400).json({
          error: `Cannot publish import in status "${job.status}". Approve a valid import first.`,
        });
      }
      const result = await commitImportJob(req.params.id, req.auth.userId);
      res.json({ success: true, result });
    } catch (err) {
      next(err);
    }
  },
);
