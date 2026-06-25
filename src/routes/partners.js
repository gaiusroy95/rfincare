import { Router } from 'express';
import multer from 'multer';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';

import { getPool } from '../db/pool.js';
import { ensurePartnerRegistrationSchema } from '../db/ensurePartnerRegistrationSchema.js';
import { newId } from '../lib/ids.js';
import { getUploadDir } from '../lib/uploadPaths.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import {
  approvePartnerRegistration,
  mapPartnerRegistrationRow,
  notifyAdminsOfPartnerApplication,
  rejectPartnerRegistration,
} from '../lib/partnerRegistration.js';

export const partnersRouter = Router();

const partnerUploadDir = () => {
  const dir = join(getUploadDir(), 'partner-registrations');
  mkdirSync(dir, { recursive: true });
  return dir;
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, partnerUploadDir()),
    filename: (_req, file, cb) => {
      const safe = basename(file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${newId()}-${safe}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const PartnerRegisterSchema = z.object({
  fullName: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(10).max(15),
  addressLine1: z.string().min(3),
  addressLine2: z.string().optional(),
  city: z.string().min(2),
  state: z.string().min(2),
  pinCode: z.string().min(4).max(10),
  panNumber: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/i, 'Invalid PAN format'),
  bankName: z.string().min(2),
  accountNumber: z.string().min(6).max(32),
  branchAddress: z.string().min(3),
  ifscCode: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/i, 'Invalid IFSC format'),
});

function bodyField(body, ...keys) {
  for (const key of keys) {
    if (body?.[key] != null && String(body[key]).trim() !== '') return String(body[key]).trim();
  }
  return '';
}

function storedPath(file) {
  if (!file) return null;
  return join('partner-registrations', file.filename);
}

partnersRouter.post(
  '/register',
  upload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'cancelledCheque', maxCount: 1 },
    { name: 'addressProof', maxCount: 1 },
  ]),
  async (req, res, next) => {
    try {
      await ensurePartnerRegistrationSchema();
      const pool = getPool();

      const parsed = PartnerRegisterSchema.parse({
        fullName: bodyField(req.body, 'fullName', 'full_name'),
        email: bodyField(req.body, 'email').toLowerCase(),
        phone: bodyField(req.body, 'phone', 'mobileNumber', 'mobile_number').replace(/\D/g, '').slice(-10),
        addressLine1: bodyField(req.body, 'addressLine1', 'address_line1'),
        addressLine2: bodyField(req.body, 'addressLine2', 'address_line2') || undefined,
        city: bodyField(req.body, 'city'),
        state: bodyField(req.body, 'state'),
        pinCode: bodyField(req.body, 'pinCode', 'pin_code'),
        panNumber: bodyField(req.body, 'panNumber', 'pan_number').toUpperCase(),
        bankName: bodyField(req.body, 'bankName', 'bank_name'),
        accountNumber: bodyField(req.body, 'accountNumber', 'account_number'),
        branchAddress: bodyField(req.body, 'branchAddress', 'branch_address'),
        ifscCode: bodyField(req.body, 'ifscCode', 'ifsc_code').toUpperCase(),
      });

      const files = req.files || {};
      const photo = files.photo?.[0];
      const cancelledCheque = files.cancelledCheque?.[0];
      const addressProof = files.addressProof?.[0];

      if (!photo) {
        const e = new Error('Profile photo is required');
        e.status = 400;
        throw e;
      }
      if (!cancelledCheque) {
        const e = new Error('Cancelled cheque scan is required');
        e.status = 400;
        throw e;
      }
      if (!addressProof) {
        const e = new Error('Address proof document is required');
        e.status = 400;
        throw e;
      }

      const [[existingAccount]] = await pool.execute(
        `SELECT id FROM auth_users WHERE email = :email LIMIT 1`,
        { email: parsed.email },
      );
      if (existingAccount) {
        const e = new Error('An account with this email already exists. Please sign in.');
        e.status = 409;
        throw e;
      }

      const [[pending]] = await pool.execute(
        `SELECT id FROM partner_registrations
         WHERE email = :email AND registration_status = 'pending' LIMIT 1`,
        { email: parsed.email },
      );
      if (pending) {
        const e = new Error('A partner application is already under review for this email.');
        e.status = 409;
        throw e;
      }

      const id = newId();
      await pool.execute(
        `INSERT INTO partner_registrations (
          id, full_name, email, phone, address_line1, address_line2, city, state, pin_code,
          pan_number, bank_name, account_number, branch_address, ifsc_code,
          photo_path, cancelled_cheque_path, address_proof_path, registration_status
        ) VALUES (
          :id, :full_name, :email, :phone, :address_line1, :address_line2, :city, :state, :pin_code,
          :pan_number, :bank_name, :account_number, :branch_address, :ifsc_code,
          :photo_path, :cancelled_cheque_path, :address_proof_path, 'pending'
        )`,
        {
          id,
          full_name: parsed.fullName,
          email: parsed.email,
          phone: parsed.phone,
          address_line1: parsed.addressLine1,
          address_line2: parsed.addressLine2 || null,
          city: parsed.city,
          state: parsed.state,
          pin_code: parsed.pinCode,
          pan_number: parsed.panNumber,
          bank_name: parsed.bankName,
          account_number: parsed.accountNumber,
          branch_address: parsed.branchAddress,
          ifsc_code: parsed.ifscCode,
          photo_path: storedPath(photo),
          cancelled_cheque_path: storedPath(cancelledCheque),
          address_proof_path: storedPath(addressProof),
        },
      );

      const [[row]] = await pool.execute(
        `SELECT * FROM partner_registrations WHERE id = :id LIMIT 1`,
        { id },
      );

      await notifyAdminsOfPartnerApplication(row).catch((err) =>
        console.warn('[partner-admin-email]', err?.message),
      );

      res.status(201).json({
        id,
        status: 'pending',
        message:
          'Application submitted successfully. Our team will verify your documents and email you within 2–3 business days.',
      });
    } catch (err) {
      if (err?.name === 'ZodError') {
        err.status = 400;
        err.message = err.issues?.[0]?.message || err.errors?.[0]?.message || 'Invalid registration data';
      }
      next(err);
    }
  },
);

partnersRouter.get(
  '/registrations',
  authenticate,
  authorize({ resource: 'registration', action: 'read' }),
  async (req, res, next) => {
    try {
      await ensurePartnerRegistrationSchema();
      const pool = getPool();
      const status = String(req.query.status || 'pending');
      const [rows] = await pool.execute(
        `SELECT * FROM partner_registrations
         WHERE registration_status = :status
         ORDER BY created_at DESC`,
        { status },
      );
      res.json({ registrations: rows.map(mapPartnerRegistrationRow) });
    } catch (err) {
      next(err);
    }
  },
);

partnersRouter.post(
  '/registrations/:id/approve',
  authenticate,
  authorize({ resource: 'registration', action: 'update' }),
  async (req, res, next) => {
    try {
      const result = await approvePartnerRegistration(req.params.id, req.auth.userId);
      res.json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  },
);

partnersRouter.post(
  '/registrations/:id/reject',
  authenticate,
  authorize({ resource: 'registration', action: 'update' }),
  async (req, res, next) => {
    try {
      const { reason } = req.body || {};
      if (!reason || !String(reason).trim()) {
        const e = new Error('Rejection reason is required');
        e.status = 400;
        throw e;
      }
      await rejectPartnerRegistration(req.params.id, req.auth.userId, String(reason).trim());
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  },
);
