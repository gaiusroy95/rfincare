import { Router } from 'express';
import { streamStoredUpload } from '../lib/uploadPaths.js';

export const uploadsRouter = Router();

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
