import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'node:fs';

import { errorMiddleware } from './middleware/errorMiddleware.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { profilesRouter } from './routes/profiles.js';
import { banksRouter } from './routes/banks.js';
import { bankProductsRouter } from './routes/bankProducts.js';
import { documentsRouter } from './routes/documents.js';
import { statesRouter } from './routes/states.js';
import { loanApplicationsRouter } from './routes/loanApplications.js';
import { adminRouter } from './routes/admin.js';
import { publicContentRouter } from './routes/publicContent.js';
import { cmsRouter } from './routes/cms.js';
import { oauthRouter } from './routes/oauth.js';
import { developmentRouter } from './routes/development.js';
import { auditLogsRouter } from './routes/auditLogs.js';
import { approvalMatrixRouter } from './routes/approvalMatrixRules.js';
import { notificationsRouter } from './routes/notifications.js';
import { leadsRouter } from './routes/leads.js';
import { eligibilityAssessmentsRouter } from './routes/eligibilityAssessments.js';
import { loanProductCatalogRouter } from './routes/loanProductCatalog.js';
import { interestMatrixRouter } from './routes/interestMatrix.js';
import { reportsRouter } from './routes/reports.js';
import { portalDashboardsRouter } from './routes/portalDashboards.js';
import { documentRequirementsRouter } from './routes/documentRequirements.js';
import { staffCommunicationRouter } from './routes/staffMessaging.js';
import { portalAgentApplicationsRouter } from './routes/portalAgentApplications.js';
import {
  adminAgentLearningRouter,
  portalAgentLearningRouter,
} from './routes/agentLearning.js';
import {
  adminEmployeeLearningRouter,
  portalEmployeeLearningRouter,
} from './routes/employeeLearning.js';
import { portalAgentProfileRouter } from './routes/portalAgentProfile.js';
import { portalEmployeeProfileRouter } from './routes/portalEmployeeProfile.js';
import { portalAdminProfileRouter } from './routes/portalAdminProfile.js';
import { milestone4AdminRouter } from './routes/milestone4Admin.js';
import { portalEmployeeMilestone4Router } from './routes/portalEmployeeMilestone4.js';
import { portalAgentMilestone4Router } from './routes/portalAgentMilestone4.js';
import { partnersRouter } from './routes/partners.js';
import { creditCardsRouter } from './routes/creditCards.js';
import { insuranceProductsRouter } from './routes/insuranceProducts.js';
import { insurancePurchasesRouter } from './routes/insurancePurchases.js';
import { insuranceWebhooksRouter } from './routes/insuranceWebhooks.js';
import { mutualFundsRouter } from './routes/mutualFunds.js';
import { fixedIncomeRouter } from './routes/fixedIncome.js';
import { postOfficeInvestmentsRouter } from './routes/postOfficeInvestments.js';
import { governmentSchemesRouter } from './routes/governmentSchemes.js';
import { investmentProductsRouter } from './routes/investmentProducts.js';
import { paymentsRouter } from './routes/payments.js';
import { translateRouter } from './routes/translate.js';
import { calculatorsRouter } from './routes/calculators.js';
import { portalCustomerRouter } from './routes/portalCustomer.js';
import { getCorsOptions } from './lib/corsOptions.js';
import { getUploadDir } from './lib/uploadPaths.js';
import { isCloudStorage } from './lib/storage/index.js';
import { uploadsRouter } from './routes/uploads.js';

export function createApp({ serveStatic = true } = {}) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const app = express();

  app.use(cors(getCorsOptions()));
  app.use('/payments', paymentsRouter);
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  app.use('/health', healthRouter);
  app.use('/auth', authRouter);
  app.use('/profiles', profilesRouter);
  app.use('/banks', banksRouter);
  app.use('/bank-products', bankProductsRouter);
  app.use('/documents', documentsRouter);
  app.use('/api/documents', documentsRouter);
  app.use('/states', statesRouter);
  app.use('/loan-applications', loanApplicationsRouter);
  app.use('/admin', adminRouter);

  // Backward-compatible /api/* aliases (older clients or proxies)
  app.use('/api/loan-applications', loanApplicationsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/auth', authRouter);
  app.use('/public', publicContentRouter);
  app.use('/cms', cmsRouter);
  app.use('/auth/oauth', oauthRouter);
  app.use('/development-panel', developmentRouter);
  app.use('/audit-logs', auditLogsRouter);
  app.use('/approval-matrix-rules', approvalMatrixRouter);
  app.use('/notifications', notificationsRouter);
  app.use('/leads', leadsRouter);
  app.use('/eligibility-assessments', eligibilityAssessmentsRouter);
  app.use('/loan-products', loanProductCatalogRouter);
  app.use('/api/loan-products', loanProductCatalogRouter);
  app.use('/interest-matrix', interestMatrixRouter);
  app.use('/admin/interest-matrix', interestMatrixRouter);
  app.use('/reports', reportsRouter);
  app.use('/admin/reports', reportsRouter);
  app.use('/portal', portalDashboardsRouter);
  app.use('/portal/communication', staffCommunicationRouter);
  app.use('/portal/agent', portalAgentApplicationsRouter);
  app.use('/portal/agent/learning', portalAgentLearningRouter);
  app.use('/portal/agent/profile', portalAgentProfileRouter);
  app.use('/admin/agent-learning', adminAgentLearningRouter);
  app.use('/admin/employee-learning', adminEmployeeLearningRouter);
  app.use('/portal/employee/learning', portalEmployeeLearningRouter);
  app.use('/portal/employee/profile', portalEmployeeProfileRouter);
  app.use('/portal/admin/profile', portalAdminProfileRouter);
  app.use('/admin/milestone4', milestone4AdminRouter);
  app.use('/portal/employee/milestone4', portalEmployeeMilestone4Router);
  app.use('/portal/agent/reports', portalAgentMilestone4Router);
  app.use('/document-requirements', documentRequirementsRouter);
  app.use('/admin/document-requirements', documentRequirementsRouter);
  app.use('/partners', partnersRouter);
  app.use('/api/partners', partnersRouter);
  app.use('/credit-cards', creditCardsRouter);
  app.use('/api/credit-cards', creditCardsRouter);
  app.use('/insurance-products', insuranceProductsRouter);
  app.use('/api/insurance-products', insuranceProductsRouter);
  app.use('/insurance-purchases', insurancePurchasesRouter);
  app.use('/api/insurance-purchases', insurancePurchasesRouter);
  app.use('/webhooks', insuranceWebhooksRouter);
  app.use('/mutual-funds', mutualFundsRouter);
  app.use('/api/mutual-funds', mutualFundsRouter);
  app.use('/fixed-income', fixedIncomeRouter);
  app.use('/api/fixed-income', fixedIncomeRouter);
  app.use('/post-office-investments', postOfficeInvestmentsRouter);
  app.use('/api/post-office-investments', postOfficeInvestmentsRouter);
  app.use('/government-schemes', governmentSchemesRouter);
  app.use('/api/government-schemes', governmentSchemesRouter);
  app.use('/investment-products', investmentProductsRouter);
  app.use('/api/investment-products', investmentProductsRouter);
  app.use('/translate', translateRouter);
  app.use('/api/translate', translateRouter);
  app.use('/calculators', calculatorsRouter);
  app.use('/api/calculators', calculatorsRouter);
  app.use('/portal/customer', portalCustomerRouter);
  app.use('/api/portal/customer', portalCustomerRouter);

  if (isCloudStorage()) {
    app.use('/uploads', uploadsRouter);
  } else {
    app.use('/uploads', express.static(getUploadDir()));
  }
  app.use('/uploads', (_req, res) => {
    res.status(404).json({ error: 'Upload not found' });
  });

  app.use(errorMiddleware);

  if (!serveStatic) {
    return app;
  }

  const buildPath = process.env.FRONTEND_DIST
    ? path.resolve(process.env.FRONTEND_DIST)
    : path.resolve(__dirname, '../../frontend/dist');

  app.use(express.static(buildPath));

  app.get('*', (req, res) => {
    if (
      req.path.startsWith('/api')
      || req.path.startsWith('/auth')
      || req.path.startsWith('/development-panel')
      || req.path.startsWith('/public')
      || req.path.startsWith('/uploads')
      || req.path.startsWith('/documents')
    ) {
      return res.status(404).json({ message: 'Not Found' });
    }
    const indexPath = path.join(buildPath, 'index.html');
    if (!existsSync(indexPath)) {
      return res.status(404).json({
        message: 'Frontend build not found. Set FRONTEND_DIST or deploy frontend/dist.',
      });
    }
    res.sendFile(indexPath);
  });

  return app;
}

