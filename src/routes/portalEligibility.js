import { Router } from 'express';
import { z } from 'zod';

import { authenticate } from '../middleware/authenticate.js';
import { calculateEligibility } from '../lib/eligibilityEngine.js';
import { assertEmployeeAccess } from '../lib/employeeAccessControls.js';
import { resolveLiveCibilForCustomerEligibility } from '../lib/eligibilityLiveCibil.js';

export const portalEligibilityRouter = Router();

const EligibilityInputSchema = z.object({
  loanType: z.string().min(1, 'Loan type is required'),
  loanAmount: z.coerce.number().positive('Loan amount must be greater than zero').max(1e12),
  monthlyIncome: z.coerce.number().positive('Monthly income must be greater than zero').max(1e12),
  extraIncome: z.coerce.number().min(0).max(1e12).optional().default(0),
  employmentType: z.string().min(1, 'Employment type is required'),
  creditScore: z.string().optional(),
  creditScoreRange: z.string().optional(),
  existingLoans: z.coerce.number().min(0).max(1e12).optional().default(0),
  collateralValue: z.coerce.number().min(0).max(1e12).optional(),
  propertyValue: z.coerce.number().min(0).max(1e12).optional(),
  loanPurpose: z.string().optional(),
  dateOfBirth: z.string().optional(),
  age: z.coerce.number().optional(),
  yearsEmployed: z.coerce.number().min(0).max(60).optional(),
  fetchLiveCibil: z.boolean().optional(),
  refreshLiveCibil: z.boolean().optional(),
  consentAccepted: z.boolean().optional(),
  panNumber: z.string().optional(),
}).refine((data) => data.creditScore || data.creditScoreRange || data.fetchLiveCibil, {
  message: 'Credit score range is required unless fetching live CIBIL',
  path: ['creditScore'],
});

function requireRole(req, roles) {
  if (!roles.includes(req.auth.role)) {
    const e = new Error('Access denied');
    e.status = 403;
    throw e;
  }
}

async function handleCalculate(req, res, next, { includeCibil = false } = {}) {
  try {
    const input = EligibilityInputSchema.parse(req.body);
    let engineInput = { ...input };
    let cibilMeta = null;

    if (includeCibil && req.auth.role === 'customer') {
      const live = await resolveLiveCibilForCustomerEligibility(req.auth.userId, input);
      if (live?.creditScore) {
        engineInput = {
          ...engineInput,
          liveCreditScore: live.creditScore,
          creditScoreRange: live.creditScoreRange || engineInput.creditScoreRange,
        };
      }
      if (live?.cibil) cibilMeta = live.cibil;
    }

    const result = await calculateEligibility(engineInput);
    res.json(cibilMeta ? { ...result, cibil: cibilMeta } : result);
  } catch (err) {
    next(err);
  }
}

portalEligibilityRouter.post('/customer/eligibility/calculate', authenticate, async (req, res, next) => {
  try {
    requireRole(req, ['customer']);
    await handleCalculate(req, res, next, { includeCibil: true });
  } catch (err) {
    next(err);
  }
});

portalEligibilityRouter.post('/agent/eligibility/calculate', authenticate, async (req, res, next) => {
  try {
    requireRole(req, ['agent', 'admin', 'super_admin']);
    await handleCalculate(req, res, next);
  } catch (err) {
    next(err);
  }
});

portalEligibilityRouter.post('/employee/eligibility/calculate', authenticate, async (req, res, next) => {
  try {
    requireRole(req, ['employee', 'admin', 'super_admin']);
    if (req.auth.role === 'employee') {
      await assertEmployeeAccess(req, 'applications', 'read');
    }
    await handleCalculate(req, res, next);
  } catch (err) {
    next(err);
  }
});

portalEligibilityRouter.post('/admin/eligibility/simulate', authenticate, async (req, res, next) => {
  try {
    requireRole(req, ['admin', 'super_admin']);
    await handleCalculate(req, res, next);
  } catch (err) {
    next(err);
  }
});
