import { Router } from 'express';
import { streamStoredUpload } from '../lib/uploadPaths.js';
import { sendCibilReportPdf } from '../lib/cibilReportStore.js';

export const uploadsRouter = Router();

/** `/uploads/cibil-reports/*` — mounted for every storage provider; bureau reports survive redeploys via the DB copy. */
export const cibilReportUploadsRouter = Router();

cibilReportUploadsRouter.get('/:fileName', async (req, res, next) => {
  try {
    await sendCibilReportPdf(res, req.params.fileName, { disposition: 'inline', prefix: 'credit-report' });
  } catch (err) {
    next(err);
  }
});

/** Stream objects from cloud storage through the same /uploads/* URLs clients already use. */
uploadsRouter.get('/*', async (req, res, next) => {
  try {
    const key = String(req.params[0] || '').replace(/^\/+/, '');
    if (!key) return res.status(404).json({ error: 'Upload not found' });

    const opened = await streamStoredUpload(`/uploads/${key}`);
    if (!opened?.stream) {
      return res.status(404).json({ error: 'Upload not found' });
    }

    res.setHeader('Content-Type', opened.contentType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    opened.stream.pipe(res);
  } catch (err) {
    next(err);
  }
});
