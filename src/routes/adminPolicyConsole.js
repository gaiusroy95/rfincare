import { Router } from 'express';
import { z } from 'zod';

import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { getPool } from '../db/pool.js';
import { newId } from '../lib/ids.js';
import {
  ensurePolicyConsoleSchema,
  listPolicyVersions,
  getPolicyVersion,
  createDraftVersion,
  submitVersion,
  approveVersion,
  rejectVersion,
  publishVersion,
  listPolicyAudit,
  createEligibilityRule,
  listEligibilityRules,
} from '../lib/policyConsole.js';
import { getMatchingConfig, saveMatchingConfig } from '../lib/matchingConfig.js';
import { evaluateRule, summarizeDecision } from '../lib/ruleEngine.js';
import { calculateEligibility } from '../lib/eligibilityEngine.js';

export const adminPolicyConsoleRouter = Router();

adminPolicyConsoleRouter.use(authenticate);

adminPolicyConsoleRouter.get(
  '/versions',
  authorize({ resource: 'bank_products', action: 'read' }),
  async (req, res, next) => {
    try {
      const rows = await listPolicyVersions({
        status: req.query.status || undefined,
        bankId: req.query.bankId || undefined,
        limit: req.query.limit,
      });
      res.json({ data: rows });
    } catch (err) {
      next(err);
    }
  },
);

adminPolicyConsoleRouter.get(
  '/versions/:id',
  authorize({ resource: 'bank_products', action: 'read' }),
  async (req, res, next) => {
    try {
      const row = await getPolicyVersion(req.params.id);
      if (!row) return res.status(404).json({ error: 'Version not found' });
      res.json({ data: row });
    } catch (err) {
      next(err);
    }
  },
);

adminPolicyConsoleRouter.post(
  '/versions',
  authorize({ resource: 'bank_products', action: 'manage' }),
  async (req, res, next) => {
    try {
      const body = z
        .object({
          bankId: z.string().min(1),
          bankProductId: z.string().optional().nullable(),
          versionLabel: z.string().min(1).max(64),
          changeReason: z.string().optional().nullable(),
          effectiveFrom: z.string().optional().nullable(),
          effectiveTo: z.string().optional().nullable(),
          snapshot: z.record(z.any()).optional().nullable(),
          seedFromApprovalMatrix: z.boolean().optional(),
        })
        .parse(req.body || {});

      const versionId = await createDraftVersion({
        bankId: body.bankId,
        bankProductId: body.bankProductId || null,
        versionLabel: body.versionLabel,
        changeReason: body.changeReason,
        effectiveFrom: body.effectiveFrom,
        effectiveTo: body.effectiveTo,
        snapshot: body.snapshot,
        actorId: req.auth.userId,
      });

      if (body.seedFromApprovalMatrix && body.bankId) {
        const pool = getPool();
        const [matrix] = await pool.query(
          `SELECT * FROM approval_matrix_rules WHERE bank_id = :bankId AND is_active = TRUE ORDER BY priority DESC LIMIT 5`,
          { bankId: body.bankId },
        );
        for (const rule of matrix) {
          const d = typeof rule.data === 'string' ? JSON.parse(rule.data) : rule.data || {};
          const conditions = [];
          if (d.min_annual_income != null || d.min_income != null) {
            conditions.push({
              fieldKey: 'annual_income',
              operator: '>=',
              value: Number(d.min_annual_income ?? d.min_income),
            });
          }
          if (d.min_credit_score != null) {
            conditions.push({
              fieldKey: 'credit_score',
              operator: '>=',
              value: Number(d.min_credit_score),
            });
          }
          if (d.max_credit_score != null) {
            conditions.push({
              fieldKey: 'credit_score',
              operator: '<=',
              value: Number(d.max_credit_score),
            });
          }
          if (d.min_age != null) {
            conditions.push({ fieldKey: 'age', operator: '>=', value: Number(d.min_age) });
          }
          if (d.max_age != null) {
            conditions.push({ fieldKey: 'age', operator: '<=', value: Number(d.max_age) });
          }
          await createEligibilityRule({
            versionId,
            bankId: body.bankId,
            bankProductId: body.bankProductId || null,
            ruleDomain: 'applicant',
            ruleCode: `AM-${rule.id.slice(0, 8)}`,
            ruleName: rule.rule_name || 'Approval matrix rule',
            severity: 'soft',
            sourceSheet: 'approval_matrix_rules',
            sourceRow: d,
            conditions,
          });
        }
      }

      res.status(201).json({ data: await getPolicyVersion(versionId) });
    } catch (err) {
      next(err);
    }
  },
);

adminPolicyConsoleRouter.post(
  '/versions/:id/submit',
  authorize({ resource: 'bank_products', action: 'manage' }),
  async (req, res, next) => {
    try {
      res.json({ data: await submitVersion(req.params.id, req.auth.userId, req.body?.reason) });
    } catch (err) {
      next(err);
    }
  },
);

adminPolicyConsoleRouter.post(
  '/versions/:id/approve',
  authorize({ resource: 'bank_products', action: 'manage' }),
  async (req, res, next) => {
    try {
      res.json({ data: await approveVersion(req.params.id, req.auth.userId, req.body?.reason) });
    } catch (err) {
      next(err);
    }
  },
);

adminPolicyConsoleRouter.post(
  '/versions/:id/reject',
  authorize({ resource: 'bank_products', action: 'manage' }),
  async (req, res, next) => {
    try {
      res.json({
        data: await rejectVersion(req.params.id, req.auth.userId, req.body?.reason || 'Rejected'),
      });
    } catch (err) {
      next(err);
    }
  },
);

adminPolicyConsoleRouter.post(
  '/versions/:id/publish',
  authorize({ resource: 'bank_products', action: 'manage' }),
  async (req, res, next) => {
    try {
      res.json({ data: await publishVersion(req.params.id, req.auth.userId, req.body?.reason) });
    } catch (err) {
      next(err);
    }
  },
);

adminPolicyConsoleRouter.get(
  '/approvals',
  authorize({ resource: 'bank_products', action: 'read' }),
  async (_req, res, next) => {
    try {
      const submitted = await listPolicyVersions({ status: 'submitted', limit: 200 });
      const approved = await listPolicyVersions({ status: 'approved', limit: 100 });
      res.json({ data: { submitted, approved } });
    } catch (err) {
      next(err);
    }
  },
);

adminPolicyConsoleRouter.get(
  '/audit',
  authorize({ resource: 'bank_products', action: 'read' }),
  async (req, res, next) => {
    try {
      res.json({
        data: await listPolicyAudit({
          versionId: req.query.versionId || undefined,
          limit: req.query.limit,
        }),
      });
    } catch (err) {
      next(err);
    }
  },
);

adminPolicyConsoleRouter.get(
  '/rules',
  authorize({ resource: 'approval_matrix', action: 'read' }),
  async (req, res, next) => {
    try {
      res.json({
        data: await listEligibilityRules({
          bankId: req.query.bankId || undefined,
          versionId: req.query.versionId || undefined,
          domain: req.query.domain || undefined,
        }),
      });
    } catch (err) {
      next(err);
    }
  },
);

adminPolicyConsoleRouter.post(
  '/rules',
  authorize({ resource: 'approval_matrix', action: 'manage' }),
  async (req, res, next) => {
    try {
      const body = z
        .object({
          versionId: z.string().optional().nullable(),
          bankId: z.string().optional().nullable(),
          bankProductId: z.string().optional().nullable(),
          ruleDomain: z.string().default('applicant'),
          ruleCode: z.string().optional().nullable(),
          ruleName: z.string().min(1),
          severity: z.enum(['soft', 'critical']).default('soft'),
          conditions: z
            .array(
              z.object({
                fieldKey: z.string(),
                operator: z.string(),
                value: z.any(),
                valueTo: z.any().optional(),
                logicGroup: z.string().optional(),
              }),
            )
            .default([]),
        })
        .parse(req.body || {});
      const id = await createEligibilityRule(body);
      const rules = await listEligibilityRules({ versionId: body.versionId, bankId: body.bankId });
      res.status(201).json({ data: rules.find((r) => r.id === id) || { id } });
    } catch (err) {
      next(err);
    }
  },
);

adminPolicyConsoleRouter.get(
  '/matching-config',
  authorize({ resource: 'approval_matrix', action: 'read' }),
  async (_req, res, next) => {
    try {
      res.json({ data: await getMatchingConfig() });
    } catch (err) {
      next(err);
    }
  },
);

adminPolicyConsoleRouter.put(
  '/matching-config',
  authorize({ resource: 'approval_matrix', action: 'manage' }),
  async (req, res, next) => {
    try {
      const body = z
        .object({
          weights: z.record(z.number()).optional(),
          decisionThresholds: z
            .object({
              eligible_min_probability: z.number().min(0).max(100).optional(),
              conditional_min_probability: z.number().min(0).max(100).optional(),
            })
            .optional(),
        })
        .parse(req.body || {});
      res.json({
        data: await saveMatchingConfig({
          weights: body.weights,
          decisionThresholds: body.decisionThresholds,
          actorId: req.auth.userId,
        }),
      });
    } catch (err) {
      next(err);
    }
  },
);

adminPolicyConsoleRouter.get(
  '/property-ltv',
  authorize({ resource: 'bank_products', action: 'read' }),
  async (req, res, next) => {
    try {
      await ensurePolicyConsoleSchema();
      const pool = getPool();
      const clauses = ['is_active = TRUE'];
      const params = {};
      if (req.query.bankId) {
        clauses.push('bank_id = :bank_id');
        params.bank_id = req.query.bankId;
      }
      if (req.query.versionId) {
        clauses.push('version_id = :version_id');
        params.version_id = req.query.versionId;
      }
      const [rows] = await pool.query(
        `SELECT * FROM property_ltv_rules WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,
        params,
      );
      res.json({ data: rows });
    } catch (err) {
      next(err);
    }
  },
);

adminPolicyConsoleRouter.post(
  '/property-ltv',
  authorize({ resource: 'bank_products', action: 'manage' }),
  async (req, res, next) => {
    try {
      await ensurePolicyConsoleSchema();
      const body = z
        .object({
          versionId: z.string().optional().nullable(),
          bankId: z.string().optional().nullable(),
          bankProductId: z.string().optional().nullable(),
          propertyType: z.string().default('residential'),
          maxLtv: z.number().min(0).max(1).default(0.75),
          minAmount: z.number().optional().nullable(),
          maxAmount: z.number().optional().nullable(),
          applicantType: z.string().optional().nullable(),
        })
        .parse(req.body || {});
      const pool = getPool();
      const id = newId();
      await pool.execute(
        `INSERT INTO property_ltv_rules (
           id, version_id, bank_id, bank_product_id, property_type, max_ltv,
           min_amount, max_amount, applicant_type
         ) VALUES (
           :id, :version_id, :bank_id, :bank_product_id, :property_type, :max_ltv,
           :min_amount, :max_amount, :applicant_type
         )`,
        {
          id,
          version_id: body.versionId || null,
          bank_id: body.bankId || null,
          bank_product_id: body.bankProductId || null,
          property_type: body.propertyType,
          max_ltv: body.maxLtv,
          min_amount: body.minAmount ?? null,
          max_amount: body.maxAmount ?? null,
          applicant_type: body.applicantType || null,
        },
      );
      res.status(201).json({ data: { id } });
    } catch (err) {
      next(err);
    }
  },
);

adminPolicyConsoleRouter.get(
  '/dscr',
  authorize({ resource: 'bank_products', action: 'read' }),
  async (req, res, next) => {
    try {
      await ensurePolicyConsoleSchema();
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT * FROM dscr_rules WHERE is_active = TRUE
         ${req.query.bankId ? 'AND bank_id = :bank_id' : ''}
         ORDER BY created_at DESC LIMIT 100`,
        req.query.bankId ? { bank_id: req.query.bankId } : {},
      );
      res.json({ data: rows });
    } catch (err) {
      next(err);
    }
  },
);

adminPolicyConsoleRouter.post(
  '/dscr',
  authorize({ resource: 'bank_products', action: 'manage' }),
  async (req, res, next) => {
    try {
      await ensurePolicyConsoleSchema();
      const body = z
        .object({
          versionId: z.string().optional().nullable(),
          bankId: z.string().optional().nullable(),
          bankProductId: z.string().optional().nullable(),
          minDscr: z.number().min(0).default(1.25),
          notes: z.string().optional().nullable(),
        })
        .parse(req.body || {});
      const pool = getPool();
      const id = newId();
      await pool.execute(
        `INSERT INTO dscr_rules (id, version_id, bank_id, bank_product_id, min_dscr, notes)
         VALUES (:id, :version_id, :bank_id, :bank_product_id, :min_dscr, :notes)`,
        {
          id,
          version_id: body.versionId || null,
          bank_id: body.bankId || null,
          bank_product_id: body.bankProductId || null,
          min_dscr: body.minDscr,
          notes: body.notes || null,
        },
      );
      res.status(201).json({ data: { id } });
    } catch (err) {
      next(err);
    }
  },
);

adminPolicyConsoleRouter.get(
  '/risk-rules',
  authorize({ resource: 'bank_products', action: 'read' }),
  async (req, res, next) => {
    try {
      await ensurePolicyConsoleSchema();
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT * FROM risk_exception_rules WHERE is_active = TRUE
         ${req.query.bankId ? 'AND bank_id = :bank_id' : ''}
         ORDER BY created_at DESC LIMIT 200`,
        req.query.bankId ? { bank_id: req.query.bankId } : {},
      );
      res.json({ data: rows });
    } catch (err) {
      next(err);
    }
  },
);

adminPolicyConsoleRouter.post(
  '/risk-rules',
  authorize({ resource: 'bank_products', action: 'manage' }),
  async (req, res, next) => {
    try {
      await ensurePolicyConsoleSchema();
      const body = z
        .object({
          versionId: z.string().optional().nullable(),
          bankId: z.string().optional().nullable(),
          bankProductId: z.string().optional().nullable(),
          ruleType: z.enum(['risk', 'fraud', 'exception']).default('risk'),
          ruleCode: z.string().optional().nullable(),
          description: z.string().min(1),
          severity: z.enum(['soft', 'critical']).default('soft'),
          condition: z.record(z.any()).optional().nullable(),
        })
        .parse(req.body || {});
      const pool = getPool();
      const id = newId();
      await pool.execute(
        `INSERT INTO risk_exception_rules (
           id, version_id, bank_id, bank_product_id, rule_type, rule_code,
           description, severity, condition_json
         ) VALUES (
           :id, :version_id, :bank_id, :bank_product_id, :rule_type, :rule_code,
           :description, :severity, :condition_json
         )`,
        {
          id,
          version_id: body.versionId || null,
          bank_id: body.bankId || null,
          bank_product_id: body.bankProductId || null,
          rule_type: body.ruleType,
          rule_code: body.ruleCode || null,
          description: body.description,
          severity: body.severity,
          condition_json: body.condition ? JSON.stringify(body.condition) : null,
        },
      );
      res.status(201).json({ data: { id } });
    } catch (err) {
      next(err);
    }
  },
);

/** Rule debugger: per-rule PASS/FAIL/NOT_EVALUATED across lenders */
adminPolicyConsoleRouter.post(
  '/debug',
  authorize({ resource: 'approval_matrix', action: 'read' }),
  async (req, res, next) => {
    try {
      const input = req.body || {};
      const eligibility = await calculateEligibility(input);
      const config = await getMatchingConfig();
      const rules = await listEligibilityRules({
        bankId: input.bankId || undefined,
        versionId: input.versionId || undefined,
      });
      const applicant = {
        monthlyIncome: Number(input.monthlyIncome || 0) + Number(input.extraIncome || 0),
        loanAmount: Number(input.loanAmount || 0),
        creditScore: Number(input.liveCreditScore || eligibility.input?.creditScore || 700),
        employmentType: input.employmentType || 'salaried',
        age: Number(input.age) || null,
        yearsEmployed: Number(input.yearsEmployed) || null,
        existingLoans: Number(input.existingLoans || 0),
        collateralValue: Number(input.collateralValue || input.propertyValue || 0),
        loanType: input.loanType || input.loanPurpose || null,
        dscr: Number(input.dscr) || null,
      };

      const byBank = new Map();
      for (const rule of rules) {
        const key = rule.bank_id || '__global__';
        if (!byBank.has(key)) byBank.set(key, []);
        byBank.get(key).push(rule);
      }

      const bankTraces = (eligibility.banks || []).map((bank) => {
        const bankRules = [
          ...(byBank.get(bank.bankId) || []),
          ...(byBank.get('__global__') || []),
        ];
        const ruleResults = bankRules.map((rule) =>
          evaluateRule(rule, rule.conditions || [], applicant),
        );
        const decision = summarizeDecision(ruleResults, {
          eligibleMin: config.decisionThresholds.eligible_min_probability,
          conditionalMin: config.decisionThresholds.conditional_min_probability,
          probability: bank.bestProbability || 0,
        });
        return {
          bankId: bank.bankId,
          bankName: bank.bankName,
          probability: bank.bestProbability,
          eligibleAmount: bank.eligibleAmount,
          decision: decision.decision,
          decisionReason: decision.reason,
          rules: ruleResults,
        };
      });

      res.json({
        data: {
          overall: eligibility,
          matchingConfig: config,
          banks: bankTraces,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);
