import { Router } from 'express';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { authenticate } from '../middleware/authenticate.js';
import {
  getFileNotificationSettings,
  saveFileNotificationSettings,
} from '../lib/fileNotificationService.js';
import {
  listCibilVendors,
  updateCibilVendor,
  pullCibilForApplication,
  pullCibilForEmployee,
  getLatestCibilCheck,
  getCibilCheckById,
} from '../lib/cibilService.js';
import { getUploadDir } from '../lib/uploadPaths.js';

export const milestone4AdminRouter = Router();

function requireAdmin(req) {
  if (!['admin', 'super_admin'].includes(req.auth.role)) {
    const e = new Error('Admin access required');
    e.status = 403;
    throw e;
  }
}

const StaffCibilPullSchema = z.object({
  fullName: z.string().min(2, 'Name is required'),
  fatherName: z.string().min(2, "Father's name is required"),
  panNumber: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/i, 'Enter a valid PAN number'),
  mobile: z.string().min(10, 'Mobile number is required'),
  pincode: z.string().regex(/^\d{6}$/, 'Enter a valid 6-digit pincode'),
  gender: z.enum(['male', 'female', 'other'], { errorMap: () => ({ message: 'Gender is required' }) }),
  consentAccepted: z.literal(true, { errorMap: () => ({ message: 'Consent is required' }) }),
  consentToken: z.string().min(16, 'OTP consent is required'),
  otpId: z.string().min(8, 'OTP consent is required'),
});

milestone4AdminRouter.use(authenticate);

milestone4AdminRouter.post('/cibil/consent/request-otp', async (req, res, next) => {
  try {
    requireAdmin(req);
    const phone = String(req.body?.mobile || req.body?.phone || '').replace(/\D/g, '').slice(-10);
    const { requestCibilConsentOtp } = await import('../lib/cibilConsentOtp.js');
    res.json(await requestCibilConsentOtp({ phone, initiatedByUserId: req.auth.userId }));
  } catch (err) {
    next(err);
  }
});

milestone4AdminRouter.post('/cibil/consent/verify-otp', async (req, res, next) => {
  try {
    requireAdmin(req);
    const phone = String(req.body?.mobile || req.body?.phone || '').replace(/\D/g, '').slice(-10);
    const otp = String(req.body?.otp || '').trim();
    const { verifyCibilConsentOtp } = await import('../lib/cibilConsentOtp.js');
    res.json(await verifyCibilConsentOtp({ phone, otp }));
  } catch (err) {
    next(err);
  }
});

milestone4AdminRouter.post('/cibil/pull', async (req, res, next) => {
  try {
    requireAdmin(req);
    const input = StaffCibilPullSchema.parse(req.body);
    const phone = String(input.mobile).replace(/\D/g, '').slice(-10);
    const { assertCibilConsentToken } = await import('../lib/cibilConsentOtp.js');
    await assertCibilConsentToken({
      phone,
      consentToken: input.consentToken,
      otpId: input.otpId,
    });
    const result = await pullCibilForEmployee(
      {
        fullName: input.fullName.trim(),
        fatherName: input.fatherName.trim(),
        panNumber: input.panNumber.toUpperCase(),
        mobile: phone,
        pincode: input.pincode,
        gender: input.gender,
        consentAccepted: true,
      },
      req.auth.userId,
      { source: 'admin_panel' },
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

milestone4AdminRouter.get('/cibil/report/:checkId', async (req, res, next) => {
  try {
    requireAdmin(req);
    const check = await getCibilCheckById(req.params.checkId);
    if (!check?.reportPath) {
      return res.status(404).json({ error: 'CIBIL report not found' });
    }
    const fileName = check.reportPath.split('/').pop();
    const fullPath = resolve(getUploadDir(), 'cibil-reports', fileName);
    if (!existsSync(fullPath)) {
      return res.status(404).json({ error: 'CIBIL report file missing on server' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="cibil-report-${fileName}"`);
    res.send(readFileSync(fullPath));
  } catch (err) {
    next(err);
  }
});

milestone4AdminRouter.get('/cibil-vendors', async (req, res, next) => {
  try {
    requireAdmin(req);
    res.json({ vendors: await listCibilVendors() });
  } catch (err) {
    next(err);
  }
});

milestone4AdminRouter.put('/cibil-vendors/:vendorKey', async (req, res, next) => {
  try {
    requireAdmin(req);
    const payload = z
      .object({
        apiKey: z.string().optional(),
        apiSecret: z.string().optional(),
        sandboxMode: z.boolean().optional(),
        isActive: z.boolean().optional(),
      })
      .parse(req.body);
    const vendors = await updateCibilVendor(req.params.vendorKey, payload, req.auth.userId);
    res.json({ vendors });
  } catch (err) {
    next(err);
  }
});

milestone4AdminRouter.post('/cibil-sandbox/:applicationId', async (req, res, next) => {
  try {
    requireAdmin(req);
    const result = await pullCibilForApplication(req.params.applicationId, { forceSandbox: true });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

milestone4AdminRouter.get('/applications/:applicationId/cibil', async (req, res, next) => {
  try {
    if (!['admin', 'super_admin', 'employee'].includes(req.auth.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const check = await getLatestCibilCheck(req.params.applicationId);
    res.json({ check });
  } catch (err) {
    next(err);
  }
});

milestone4AdminRouter.get('/applications/:applicationId/cibil/report', async (req, res, next) => {
  try {
    if (!['admin', 'super_admin', 'employee'].includes(req.auth.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const check = await getLatestCibilCheck(req.params.applicationId);
    if (!check?.reportPath) return res.status(404).json({ error: 'Report not found' });
    const fileName = check.reportPath.split('/').pop();
    const fullPath = resolve(getUploadDir(), 'cibil-reports', fileName);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="cibil-${fileName}"`);
    res.send(readFileSync(fullPath));
  } catch (err) {
    next(err);
  }
});

milestone4AdminRouter.get('/file-notification-settings', async (req, res, next) => {
  try {
    requireAdmin(req);
    res.json(await getFileNotificationSettings());
  } catch (err) {
    next(err);
  }
});

milestone4AdminRouter.put('/file-notification-settings', async (req, res, next) => {
  try {
    requireAdmin(req);
    const settings = await saveFileNotificationSettings(req.body, req.auth.userId);
    res.json(settings);
  } catch (err) {
    next(err);
  }
});
