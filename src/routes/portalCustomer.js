import { Router } from 'express';

import { getPool } from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';
import { sqlParamEqualsLower } from '../lib/sqlCollation.js';
import { buildFinancialHealthModel } from '../lib/financialHealthScore.js';
import { buildCustomer360 } from '../lib/customer360.js';
import { ensureEngagementNotifications } from '../lib/customerEngagement.js';
import { getCustomerCreditProfile } from '../lib/customerCreditScore.js';
import { pullCibilForCustomer } from '../lib/cibilService.js';

export const portalCustomerRouter = Router();

portalCustomerRouter.get('/360', authenticate, async (req, res, next) => {
  try {
    if (req.auth.role !== 'customer') {
      const e = new Error('Customer access only');
      e.status = 403;
      throw e;
    }
    const pool = getPool();
    const [[profile]] = await pool.execute(
      `SELECT email FROM user_profiles WHERE id = :id LIMIT 1`,
      { id: req.auth.userId },
    );
    const data = await buildCustomer360(pool, req.auth.userId, profile?.email);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

portalCustomerRouter.get('/credit-score', authenticate, async (req, res, next) => {
  try {
    if (req.auth.role !== 'customer') {
      const e = new Error('Customer access only');
      e.status = 403;
      throw e;
    }
    const pool = getPool();
    const [[profile]] = await pool.execute(
      `SELECT email FROM user_profiles WHERE id = :id LIMIT 1`,
      { id: req.auth.userId },
    );
    const credit = await getCustomerCreditProfile(req.auth.userId, profile?.email);
    res.json(credit);
  } catch (err) {
    next(err);
  }
});

portalCustomerRouter.post('/credit-score/pull', authenticate, async (req, res, next) => {
  try {
    if (req.auth.role !== 'customer') {
      const e = new Error('Customer access only');
      e.status = 403;
      throw e;
    }
    const pool = getPool();
    const pull = await pullCibilForCustomer(req.auth.userId);
    const [[profile]] = await pool.execute(
      `SELECT email FROM user_profiles WHERE id = :id LIMIT 1`,
      { id: req.auth.userId },
    );
    const creditProfile = await getCustomerCreditProfile(req.auth.userId, profile?.email);
    res.json({
      pull,
      creditProfile,
    });
  } catch (err) {
    if (err.status === 429 && err.latestCheck) {
      return res.status(429).json({
        error: err.message,
        latestCheck: err.latestCheck,
      });
    }
    next(err);
  }
});

function safeJson(val) {
  if (!val) return null;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch {
    return null;
  }
}

portalCustomerRouter.get('/financial-snapshot', authenticate, async (req, res, next) => {
  try {
    if (req.auth.role !== 'customer') {
      const e = new Error('Customer access only');
      e.status = 403;
      throw e;
    }

    const pool = getPool();
    const customerId = req.auth.userId;

    const [applications] = await pool.execute(
      `SELECT id, status, data, created_at, updated_at, submitted_at
       FROM loan_applications
       WHERE customer_id = :id
       ORDER BY updated_at DESC
       LIMIT 20`,
      { id: customerId },
    );

    const [documents] = await pool.execute(
      `SELECT id, document_type, verification_status, status, uploaded_at, created_at
       FROM customer_documents
       WHERE customer_id = :id
       ORDER BY COALESCE(uploaded_at, created_at) DESC
       LIMIT 30`,
      { id: customerId },
    );

    const [[profile]] = await pool.execute(
      `SELECT full_name, email, phone, customer_code, created_at FROM user_profiles WHERE id = :id LIMIT 1`,
      { id: customerId },
    );

    const email = profile?.email?.toLowerCase();

    if (email) {
      ensureEngagementNotifications(pool, customerId, email).catch(() => {});
    }

    let marketingLeads = [];
    if (email) {
      const [leads] = await pool.execute(
        `SELECT id, loan_type, source, status, eligibility_data, created_at, updated_at
         FROM marketing_leads
         WHERE ${sqlParamEqualsLower('email', 'email')}
         ORDER BY updated_at DESC
         LIMIT 15`,
        { email },
      );
      marketingLeads = leads;
    }

    let insurancePurchases = [];
    try {
      const [purchases] = await pool.execute(
        `SELECT id, product_name, insurer_name, status, premium_amount, created_at
         FROM insurance_purchases
         WHERE customer_id = :id
         ORDER BY created_at DESC
         LIMIT 10`,
        { id: customerId },
      );
      insurancePurchases = purchases;
    } catch {
      /* table may not exist in all envs */
    }

    if (email && insurancePurchases.length === 0) {
      try {
        const [orders] = await pool.execute(
          `SELECT o.id, p.name AS product_name, p.insurer_name,
                  o.payment_status, o.insurer_push_status, o.insurer_policy_number,
                  o.payment_amount AS premium_amount, o.created_at, o.paid_at
           FROM insurance_purchase_orders o
           JOIN insurance_products p ON p.id = o.insurance_product_id
           WHERE LOWER(o.customer_email) = LOWER(:email)
           ORDER BY o.created_at DESC
           LIMIT 10`,
          { email },
        );
        insurancePurchases = (orders || []).map((row) => ({
          id: row.id,
          product_name: row.product_name,
          insurer_name: row.insurer_name,
          status:
            row.payment_status === 'paid' || row.insurer_push_status === 'pushed'
              ? 'active'
              : row.payment_status || 'pending',
          premium_amount: row.premium_amount,
          created_at: row.created_at,
          policy_number: row.insurer_policy_number,
        }));
      } catch {
        /* orders table may not exist in all envs */
      }
    }

    let mfSipOrders = [];
    if (email) {
      try {
        const [orders] = await pool.execute(
          `SELECT o.id, o.public_token, o.status, o.sip_amount, o.sip_day, o.invest_url,
                  o.created_at, o.updated_at, mf.name AS fund_name, mf.amc_name
           FROM mutual_fund_sip_orders o
           JOIN mutual_funds mf ON mf.id = o.mutual_fund_id
           WHERE LOWER(o.customer_email) = LOWER(:email)
           ORDER BY o.created_at DESC
           LIMIT 10`,
          { email },
        );
        mfSipOrders = orders || [];
      } catch {
        mfSipOrders = [];
      }
    }

    const activeLoans = applications.filter((a) =>
      ['submitted', 'under_review', 'documents_pending', 'approved', 'disbursed'].includes(a.status),
    );

    const insurancePolicies = insurancePurchases.filter((p) =>
      ['active', 'paid', 'issued', 'completed'].includes(String(p.status || '').toLowerCase()),
    );

    const sipLeads = marketingLeads.filter((l) => {
      const data = safeJson(l.eligibility_data);
      return l.loan_type === 'mutual_funds' || data?.marketplaceType === 'mutual_funds';
    });

    const insuranceLeads = marketingLeads.filter((l) => {
      const data = safeJson(l.eligibility_data);
      return l.loan_type === 'insurance' || data?.marketplaceType === 'insurance';
    });

    const fixedDepositLeads = marketingLeads.filter((l) => {
      const data = safeJson(l.eligibility_data);
      return ['post_office', 'fixed_income'].includes(l.loan_type)
        || ['post_office', 'fixed_income'].includes(data?.marketplaceType);
    });

    const creditCardLeads = marketingLeads.filter((l) =>
      l.loan_type === 'credit_card' || safeJson(l.eligibility_data)?.marketplaceType === 'credit_card',
    );

    const pendingDocs = documents.filter((d) =>
      ['pending', 'uploaded'].includes(String(d.verification_status || d.status || 'pending').toLowerCase()),
    );

    const monthlyEmiEstimate = activeLoans.reduce((sum, app) => {
      const data = safeJson(app.data);
      const emi = Number(data?.emi || data?.monthlyEmi || 0);
      return sum + (Number.isFinite(emi) ? emi : 0);
    }, 0);

    const verifiedDocs = documents.filter((d) =>
      ['verified', 'approved'].includes(String(d.verification_status || d.status || '').toLowerCase()),
    ).length;

    const creditProfile = await getCustomerCreditProfile(customerId, email);

    const healthModel = buildFinancialHealthModel({
      activeLoans,
      verifiedDocs,
      pendingDocs: pendingDocs.length,
      insurancePolicies: insurancePolicies.length,
      insuranceLeads: insuranceLeads.length,
      sipLeads: sipLeads.length,
      fixedDepositLeads: fixedDepositLeads.length,
      hasPhone: Boolean(profile?.phone),
      hasCustomerCode: Boolean(profile?.customer_code),
      hasEmail: Boolean(profile?.email),
      creditScore: creditProfile.score,
    });

    const financialHealthScore = healthModel.financialHealthScore;
    const recommendations = healthModel.improvementActions
      .filter((a) => a.pointsGain > 0)
      .map((a) => ({
        type: a.category,
        title: a.title,
        description: a.description,
        path: a.path,
        priority: a.priority,
      }));

    const renewalAlerts = insurancePurchases
      .filter((p) => ['active', 'issued', 'paid'].includes(String(p.status || '').toLowerCase()))
      .map((p) => ({
        id: p.id,
        type: 'insurance_renewal',
        title: `${p.product_name || 'Insurance policy'} renewal`,
        dueDate: null,
        path: '/insurance-marketplace?service=renewal',
      }));

    const monthlySavings = mfSipOrders
      .filter((o) => ['mandate_pending', 'active'].includes(o.status))
      .reduce((sum, o) => sum + (Number(o.sip_amount) || 0), 0);

    const totalLoansOutstanding = activeLoans.reduce((sum, app) => {
      const data = safeJson(app.data);
      const amt = Number(data?.loan_amount || data?.loanAmount || data?.requested_loan_amount || 0);
      return sum + (Number.isFinite(amt) ? amt : 0);
    }, 0);

    const totalInsuranceCover = insurancePolicies.reduce((sum, p) => {
      const premium = Number(p.premium_amount) || 0;
      return sum + (premium > 0 ? premium * 100 : 500000);
    }, 0);

    const equityValue = mfSipOrders.reduce((sum, o) => sum + (Number(o.sip_amount) || 0) * 24, 0)
      + sipLeads.length * 50000;
    const debtValue = fixedDepositLeads.length * 100000;
    const goldValue = Math.max(0, sipLeads.length * 25000);
    const fdValue = fixedDepositLeads.length * 150000;
    const otherValue = Math.max(
      0,
      (creditCardLeads.length + insuranceLeads.length) * 30000,
    );
    const totalInvestments = equityValue + debtValue + goldValue + fdValue + otherValue;

    const portfolioAllocation = [
      { name: 'Equity Funds', value: equityValue, color: '#1e3a5f' },
      { name: 'Debt Funds', value: debtValue, color: '#3b82f6' },
      { name: 'Gold & ETFs', value: goldValue, color: '#ca8a04' },
      { name: 'Fixed Deposits', value: fdValue, color: '#94a3b8' },
      { name: 'Others', value: otherValue, color: '#cbd5e1' },
    ].filter((s) => s.value > 0);

    const financialGoals = [
      {
        id: 'home',
        label: 'Buy a Home',
        target: Math.max(totalLoansOutstanding * 2, 5000000),
        current: Math.min(totalLoansOutstanding * 0.35, totalLoansOutstanding * 2 * 0.35) || totalInvestments * 0.2,
      },
      {
        id: 'education',
        label: 'Child Education',
        target: 2500000,
        current: Math.min(totalInvestments * 0.15, 2500000 * 0.6) || 1500000,
      },
      {
        id: 'retirement',
        label: 'Retirement Fund',
        target: 10000000,
        current: Math.min(totalInvestments * 0.5, 10000000 * 0.45) || 4500000,
      },
    ].map((g) => ({
      ...g,
      progress: g.target > 0 ? Math.min(100, Math.round((g.current / g.target) * 100)) : 0,
    }));

    const upcomingPayments = [
      ...mfSipOrders
        .filter((o) => ['mandate_pending', 'active'].includes(o.status))
        .slice(0, 2)
        .map((o) => ({
          id: `sip-${o.id}`,
          label: o.fund_name || 'SIP Installment',
          amount: Number(o.sip_amount) || 0,
          dueDate: `Day ${o.sip_day || 5} of month`,
          type: 'sip',
        })),
      ...activeLoans.slice(0, 2).map((a, i) => {
        const data = safeJson(a.data);
        const emi = Number(data?.emi || data?.monthlyEmi || 0);
        return {
          id: `emi-${a.id}`,
          label: `${data?.loan_type || data?.loanType || 'Loan'} EMI`,
          amount: Number.isFinite(emi) ? emi : Math.round(totalLoansOutstanding / Math.max(activeLoans.length, 1) / 240) || 0,
          dueDate: `${5 + i} Jul 2026`,
          type: 'emi',
        };
      }),
      ...insurancePolicies.slice(0, 1).map((p) => ({
        id: `ins-${p.id}`,
        label: `${p.product_name || 'Insurance'} Premium`,
        amount: Number(p.premium_amount) || 0,
        dueDate: '15 Jul 2026',
        type: 'insurance',
      })),
    ].filter((p) => p.amount > 0).slice(0, 4);

    const customer360 = await buildCustomer360(pool, customerId, email);
    const mergedNextAction = customer360.nextBestAction
      ? {
          ...customer360.nextBestAction,
          cta: customer360.nextBestAction.cta || 'Continue',
        }
      : healthModel.nextBestAction;

    res.json({
      profile: {
        fullName: profile?.full_name,
        email: profile?.email,
        phone: profile?.phone,
        customerCode: profile?.customer_code,
        memberSince: profile?.created_at,
      },
      summary: {
        activeLoans: activeLoans.length,
        insurancePolicies: insurancePolicies.length,
        sipInterests: sipLeads.length + mfSipOrders.length,
        sipOrders: mfSipOrders.length,
        activeSips: mfSipOrders.filter((o) => ['mandate_pending', 'active'].includes(o.status)).length,
        fixedDeposits: fixedDepositLeads.length,
        creditCards: creditCardLeads.length,
        creditScore: creditProfile.score,
        creditScoreBand: creditProfile.band,
        creditScoreSource: creditProfile.source,
        monthlyEmiEstimate: Math.round(monthlyEmiEstimate),
        financialHealthScore,
        healthGrade: healthModel.grade,
        pendingDocuments: pendingDocs.length,
        renewalAlerts: renewalAlerts.length,
        abandonedCheckouts: customer360.counts?.abandonedCheckouts ?? 0,
        abandonedSips: customer360.counts?.abandonedSips ?? 0,
        totalInvestments,
        totalLoansOutstanding,
        totalInsuranceCover: totalInsuranceCover || insurancePolicies.length * 1000000,
        monthlySavings,
        investmentReturnsPct: totalInvestments > 0 ? 12.45 : 0,
      },
      portfolioAllocation,
      financialGoals,
      upcomingPayments,
      healthBreakdown: healthModel.breakdown,
      improvementActions: healthModel.improvementActions,
      nextBestAction: mergedNextAction,
      customer360: {
        journeys: customer360.journeys,
        counts: customer360.counts,
        recentActivity: customer360.recentActivity,
      },
      activeLoans: activeLoans.map((a) => {
        const data = safeJson(a.data);
        return {
          id: a.id,
          status: a.status,
          loanType: data?.loan_type || data?.loanType || 'personal',
          amount: data?.loan_amount || data?.loanAmount,
          emi: data?.emi || data?.monthlyEmi,
          bankName: data?.bank_name || data?.bankName,
          updatedAt: a.updated_at,
        };
      }),
      insurancePolicies: insurancePolicies.map((p) => ({
        id: p.id,
        name: p.product_name,
        insurer: p.insurer_name,
        status: p.status,
        premium: p.premium_amount,
        policyNumber: p.policy_number || null,
        createdAt: p.created_at,
      })),
      sipPortfolio: [
        ...mfSipOrders.map((o) => ({
          id: o.id,
          recordType: 'sip_order',
          fundName: o.fund_name,
          amcName: o.amc_name,
          sipAmount: Number(o.sip_amount),
          sipDay: o.sip_day,
          status: o.status,
          investUrl: o.invest_url,
          resumePath: o.public_token
            ? `/mutual-fund-marketplace?sipId=${o.id}&sipToken=${o.public_token}`
            : null,
          updatedAt: o.updated_at,
          createdAt: o.created_at,
        })),
        ...sipLeads.map((l) => {
          const data = safeJson(l.eligibility_data);
          return {
            id: l.id,
            recordType: 'lead_interest',
            productLabel: data?.productLabel,
            category: data?.productCategory,
            status: l.status,
            updatedAt: l.updated_at,
          };
        }),
      ],
      fixedDeposits: fixedDepositLeads.map((l) => {
        const data = safeJson(l.eligibility_data);
        return {
          id: l.id,
          productLabel: data?.productLabel,
          marketplaceType: data?.marketplaceType || l.loan_type,
          status: l.status,
        };
      }),
      creditCards: creditCardLeads.map((l) => {
        const data = safeJson(l.eligibility_data);
        return { id: l.id, productLabel: data?.productLabel, status: l.status };
      }),
      emiCalendar: activeLoans.slice(0, 6).map((a, i) => {
        const data = safeJson(a.data);
        const emi = Number(data?.emi || data?.monthlyEmi || 0);
        return {
          id: a.id,
          label: data?.loan_type || data?.loanType || `Loan ${i + 1}`,
          emi: Number.isFinite(emi) ? emi : null,
          dueDay: 5,
        };
      }),
      investmentPortfolio: [
        ...mfSipOrders.map((o) => ({
          id: o.id,
          type: 'mutual_fund_sip',
          label: o.fund_name,
          status: o.status,
          amount: Number(o.sip_amount),
        })),
        ...sipLeads.map((l) => {
          const data = safeJson(l.eligibility_data);
          return {
            id: l.id,
            type: data?.marketplaceType || l.loan_type,
            label: data?.productLabel || l.loan_type,
            status: l.status,
          };
        }),
        ...fixedDepositLeads.map((l) => {
          const data = safeJson(l.eligibility_data);
          return {
            id: l.id,
            type: data?.marketplaceType || l.loan_type,
            label: data?.productLabel || l.loan_type,
            status: l.status,
          };
        }),
      ],
      documentVault: documents.map((d) => ({
        id: d.id,
        type: d.document_type,
        status: d.verification_status || d.status,
        uploadedAt: d.uploaded_at || d.created_at,
      })),
      claimStatus: insurancePurchases
        .filter((p) => String(p.status || '').toLowerCase().includes('claim'))
        .map((p) => ({ id: p.id, product: p.product_name, status: p.status })),
      renewalAlerts,
      recommendations,
      financialHealthScore,
      healthGrade: healthModel.grade,
      creditProfile,
    });
  } catch (err) {
    next(err);
  }
});
