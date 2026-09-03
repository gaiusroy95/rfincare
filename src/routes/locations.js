import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';

import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { getPool } from '../db/pool.js';
import {
  ensureGeoSchema,
  listDistricts,
  listCities,
  listTehsils,
  listVillages,
  lookupPincode,
  createGeoNode,
  listServiceability,
  upsertServiceability,
  seedDemoGeoIfEmpty,
} from '../lib/geoHierarchy.js';
import {
  buildServiceabilityTemplateWorkbook,
  parseServiceabilityUpload,
  importServiceabilityForBank,
} from '../lib/geoServiceabilityImport.js';

export const locationsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || '').toLowerCase();
    if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv')) {
      cb(null, true);
      return;
    }
    cb(new Error('Only .xlsx, .xls, or .csv files are accepted'));
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

locationsRouter.get('/states', async (_req, res, next) => {
  try {
    await ensureGeoSchema();
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, state_name AS name, state_name, is_active FROM indian_states
       WHERE is_active = TRUE ORDER BY state_name`,
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

locationsRouter.get('/districts', async (req, res, next) => {
  try {
    if (!req.query.stateId) return res.status(400).json({ error: 'stateId required' });
    res.json({ data: await listDistricts(req.query.stateId) });
  } catch (err) {
    next(err);
  }
});

locationsRouter.get('/cities', async (req, res, next) => {
  try {
    if (!req.query.districtId) return res.status(400).json({ error: 'districtId required' });
    res.json({ data: await listCities(req.query.districtId) });
  } catch (err) {
    next(err);
  }
});

locationsRouter.get('/tehsils', async (req, res, next) => {
  try {
    res.json({
      data: await listTehsils({
        districtId: req.query.districtId || undefined,
        cityId: req.query.cityId || undefined,
      }),
    });
  } catch (err) {
    next(err);
  }
});

locationsRouter.get('/villages', async (req, res, next) => {
  try {
    res.json({
      data: await listVillages({
        districtId: req.query.districtId || undefined,
        tehsilId: req.query.tehsilId || undefined,
      }),
    });
  } catch (err) {
    next(err);
  }
});

locationsRouter.get('/pincode/:pin', async (req, res, next) => {
  try {
    res.json({ data: await lookupPincode(req.params.pin) });
  } catch (err) {
    next(err);
  }
});

locationsRouter.post(
  '/nodes',
  authenticate,
  authorize({ resource: 'banks', action: 'manage' }),
  async (req, res, next) => {
    try {
      const body = z
        .object({
          level: z.enum(['district', 'city', 'tehsil', 'village', 'pincode']),
          name: z.string().optional(),
          stateId: z.string().optional(),
          districtId: z.string().optional(),
          cityId: z.string().optional(),
          tehsilId: z.string().optional(),
          villageId: z.string().optional(),
          pincode: z.string().optional(),
          locality: z.string().optional(),
          code: z.string().optional(),
        })
        .parse(req.body || {});
      if (body.level !== 'pincode' && !body.name) {
        return res.status(400).json({ error: 'name required' });
      }
      if (body.level === 'pincode' && !body.pincode) {
        return res.status(400).json({ error: 'pincode required' });
      }
      const id = await createGeoNode(body.level, body);
      res.status(201).json({ data: { id } });
    } catch (err) {
      next(err);
    }
  },
);

locationsRouter.post(
  '/seed-demo',
  authenticate,
  authorize({ resource: 'banks', action: 'manage' }),
  async (_req, res, next) => {
    try {
      res.json({ data: await seedDemoGeoIfEmpty() });
    } catch (err) {
      next(err);
    }
  },
);

/** Template download — register before /serviceability list route */
async function sendServiceabilityTemplate(_req, res, next) {
  try {
    const buffer = buildServiceabilityTemplateWorkbook();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="lender-serviceability-by-pin.xlsx"',
    );
    res.send(buffer);
  } catch (err) {
    next(err);
  }
}

locationsRouter.get(
  '/serviceability-template',
  authenticate,
  authorize({ resource: 'banks', action: 'read' }),
  sendServiceabilityTemplate,
);

locationsRouter.get(
  '/serviceability/template',
  authenticate,
  authorize({ resource: 'banks', action: 'read' }),
  sendServiceabilityTemplate,
);

locationsRouter.get(
  '/serviceability',
  authenticate,
  authorize({ resource: 'banks', action: 'read' }),
  async (req, res, next) => {
    try {
      res.json({ data: await listServiceability({ bankId: req.query.bankId || undefined }) });
    } catch (err) {
      next(err);
    }
  },
);

locationsRouter.post(
  '/serviceability',
  authenticate,
  authorize({ resource: 'banks', action: 'manage' }),
  async (req, res, next) => {
    try {
      const body = z
        .object({
          id: z.string().optional(),
          bankId: z.string().min(1),
          bankProductId: z.string().optional().nullable(),
          level: z.string().default('pincode'),
          pincode: z.string().optional().nullable(),
          stateId: z.string().optional().nullable(),
          districtId: z.string().optional().nullable(),
          cityId: z.string().optional().nullable(),
          status: z.enum(['serviceable', 'restricted', 'not_serviceable']).default('serviceable'),
          notes: z.string().optional().nullable(),
        })
        .parse(req.body || {});
      const id = await upsertServiceability(body, req.auth.userId);
      res.status(201).json({ data: { id } });
    } catch (err) {
      next(err);
    }
  },
);

locationsRouter.post(
  '/serviceability/import',
  authenticate,
  authorize({ resource: 'banks', action: 'manage' }),
  wrapMulter(upload.single('file')),
  async (req, res, next) => {
    try {
      const bankId = String(req.body?.bankId || '').trim();
      if (!bankId) return res.status(400).json({ error: 'bankId is required' });
      if (!req.file?.buffer?.length) {
        return res.status(400).json({ error: 'Excel or CSV file is required (field name: file)' });
      }
      const replaceExisting = String(req.body?.replaceExisting || '').toLowerCase() === 'true';
      const parsed = parseServiceabilityUpload(req.file.buffer, req.file.originalname);
      if (!parsed.valid) {
        return res.status(400).json({
          error: 'Validation failed',
          errors: parsed.errors,
          preview: { rowCount: parsed.rows.length },
        });
      }
      const result = await importServiceabilityForBank({
        bankId,
        rows: parsed.rows,
        replaceExisting,
      });
      res.json({
        data: {
          ...result,
          message: `Imported ${result.totalRows} PIN rows for ${result.bankName}`,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/** Cascade helper used by customer forms */
locationsRouter.get('/cascade', async (req, res, next) => {
  try {
    await ensureGeoSchema();
    const pool = getPool();
    const [states] = await pool.query(
      `SELECT id, state_name AS name FROM indian_states WHERE is_active = TRUE ORDER BY state_name`,
    );
    let districts = [];
    let cities = [];
    let tehsils = [];
    let villages = [];
    let pincodes = [];
    if (req.query.stateId) districts = await listDistricts(req.query.stateId);
    if (req.query.districtId) {
      cities = await listCities(req.query.districtId);
      tehsils = await listTehsils({ districtId: req.query.districtId });
      villages = await listVillages({ districtId: req.query.districtId });
    }
    if (req.query.cityId) {
      const [pins] = await pool.query(
        `SELECT id, pincode, locality FROM geo_pincodes WHERE city_id = :city_id AND is_active = TRUE ORDER BY pincode`,
        { city_id: req.query.cityId },
      );
      pincodes = pins;
    }
    res.json({ data: { states, districts, cities, tehsils, villages, pincodes } });
  } catch (err) {
    next(err);
  }
});
