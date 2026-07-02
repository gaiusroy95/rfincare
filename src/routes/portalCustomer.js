import { Router } from 'express';

import { getPool } from '../db/pool.js';
import { authenticate } from '../middleware/authenticate.js';
import { sqlParamEqualsLower } from '../lib/sqlCollation.js';

export const portalCustomerRouter = Router();

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

    const financialHealthScore = Math.min(
      100,
      Math.round(
        (activeLoans.length > 0 ? 20 : 10)
        + (documents.filter((d) => ['verified', 'approved'].includes(String(d.verification_status || d.status))).length * 3)
        + (insurancePolicies.length > 0 ? 15 : 0)
        + (sipLeads.length > 0 ? 15 : 0)
        + (pendingDocs.length === 0 ? 20 : Math.max(0, 20 - pendingDocs.length * 4))
        + (profile?.phone ? 10 : 0)
        + (profile?.customer_code ? 10 : 0),
      ),
    );

    const recommendations = [];
    if (!insurancePolicies.length && !insuranceLeads.length) {
      recommendations.push({
        type: 'insurance',
        title: 'Protect your family',
        description: 'Compare term life and health insurance plans.',
        path: '/insurance-marketplace',
        priority: 'high',
      });
    }
    if (!sipLeads.length) {
      recommendations.push({
        type: 'investment',
        title: 'Start a SIP',
        description: 'Build wealth with mutual fund SIPs from ₹500/month.',
        path: '/mutual-fund-marketplace',
        priority: 'medium',
      });
    }
    if (!fixedDepositLeads.length) {
      recommendations.push({
        type: 'savings',
        title: 'Explore fixed income',
        description: 'Tax-saving FDs and post office schemes for stable returns.',
        path: '/tax-saving',
        priority: 'medium',
      });
    }
    recommendations.push({
      type: 'calculator',
      title: 'Plan your retirement',
      description: 'Use our retirement corpus planner to estimate your needs.',
      path: '/resources/calculators/retirement-corpus',
      priority: 'low',
    });

    const renewalAlerts = insurancePurchases
      .filter((p) => ['active', 'issued', 'paid'].includes(String(p.status || '').toLowerCase()))
      .map((p) => ({
        id: p.id,
        type: 'insurance_renewal',
        title: `${p.product_name || 'Insurance policy'} renewal`,
        dueDate: null,
        path: '/insurance-marketplace',
      }));

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
        sipInterests: sipLeads.length,
        fixedDeposits: fixedDepositLeads.length,
        creditCards: creditCardLeads.length,
        creditScore: null,
        monthlyEmiEstimate: Math.round(monthlyEmiEstimate),
        financialHealthScore,
        pendingDocuments: pendingDocs.length,
        renewalAlerts: renewalAlerts.length,
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
        createdAt: p.created_at,
      })),
      sipPortfolio: sipLeads.map((l) => {
        const data = safeJson(l.eligibility_data);
        return {
          id: l.id,
          productLabel: data?.productLabel,
          category: data?.productCategory,
          status: l.status,
          updatedAt: l.updated_at,
        };
      }),
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
      investmentPortfolio: [...sipLeads, ...fixedDepositLeads].map((l) => {
        const data = safeJson(l.eligibility_data);
        return {
          id: l.id,
          type: data?.marketplaceType || l.loan_type,
          label: data?.productLabel || l.loan_type,
          status: l.status,
        };
      }),
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
    });
  } catch (err) {
    next(err);
  }
});
