import { Router } from 'express';
import { getPlatformArchitecture, checkDatabaseConnection } from '../lib/architecture.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  const db = await checkDatabaseConnection();
  res.json({
    ok: db.ok,
    ts: new Date().toISOString(),
    architecture: getPlatformArchitecture(),
    database: db,
  });
});
