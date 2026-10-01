import { Router } from 'express';
import { getPlatformArchitecture, checkDatabaseConnection } from '../lib/architecture.js';

export const healthRouter = Router();

/** Bump when shipping API routes that frontends depend on (e.g. agent delete). */
export const API_BUILD = {
  id: '2026-10-01-appointment-meet-email',
  features: {
    agentPermanentDelete: true,
    agentDeleteViaPatch: true,
    agentDeletePost: true,
    flashTileImageUpload: true,
    learningPermanentDelete: true,
    leadCsvSourceLabel: true,
    bureauRoutingExperianCibil: true,
    agentExperianCheck: true,
    cibilReportsInDb: true,
    appointmentMeetLink: true,
    appointmentMsg91EmailPreferred: true,
  },
};

healthRouter.get('/', async (_req, res) => {
  const db = await checkDatabaseConnection();
  res.json({
    ok: db.ok,
    ts: new Date().toISOString(),
    build: API_BUILD,
    architecture: getPlatformArchitecture(),
    database: db,
  });
});
