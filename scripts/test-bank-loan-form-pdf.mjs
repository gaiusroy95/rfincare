/**
 * Smoke-test official bank loan application form PDF generation.
 * Usage (from backend/): node scripts/test-bank-loan-form-pdf.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildBankLoanApplicationFormPdf,
  resolveBlankTemplatePath,
} from '../src/lib/bankLoanApplicationFormPdf.js';

const template = resolveBlankTemplatePath();
if (!template) {
  console.error('FAIL: template missing at assets/forms/Rfincare_Bank_Loan_Application_Form.pdf');
  process.exit(1);
}
console.log('OK template:', template);

const sample = {
  row: {
    id: 'test-app-001',
    application_number: 'RFA-TEST-001',
    customer_full_name: 'Rahul Sharma',
    customer_email: 'rahul@example.com',
    customer_phone: '9876543210',
    sourced_agent_code: 'RFA-1001',
    status: 'submitted',
    submitted_at: new Date().toISOString(),
    document_stage_status: 'documents_pending',
    bank_approval_status: 'submitted_to_bank',
  },
  data: {
    title: 'Mr',
    firstName: 'Rahul',
    lastName: 'Sharma',
    fatherName: 'Suresh Sharma',
    dateOfBirth: '1990-05-15',
    gender: 'Male',
    maritalStatus: 'Married',
    numberOfDependents: '2',
    pan: 'ABCDE1234F',
    aadhaar: '1234',
    phone: '9876543210',
    email: 'rahul@example.com',
    addressLine1: '12 MG Road',
    addressLine2: 'Near Metro',
    city: 'Jaipur',
    district: 'Jaipur',
    state: 'Rajasthan',
    pinCode: '302001',
    yearsAtAddress: '5',
    residenceType: 'Owned',
    employmentType: 'Salaried',
    employerName: 'Acme Pvt Ltd',
    jobTitle: 'Manager',
    industry: 'IT',
    yearsEmployed: '4',
    monthlyIncome: 75000,
    extraIncome: 5000,
    monthlyDebtPayments: 12000,
    bankName: 'HDFC Bank',
    accountNumber: 'XXXX1234',
    ifsc: 'HDFC0001234',
    loanType: 'Personal Loan',
    loanPurpose: 'Personal Loan',
    requestedLoanAmount: 500000,
    preferredTenure: '36 months',
    preferredBankName: 'HDFC Bank',
    agreeTerms: true,
    consentWhatsapp: true,
    consentEmail: true,
    consentMarketing: false,
    coApplicant: {
      firstName: 'Priya',
      lastName: 'Sharma',
      relationship: 'Spouse',
      phone: '9876501234',
      email: 'priya@example.com',
      pan: 'FGHIJ5678K',
      aadhaar: '5678',
      gender: 'Female',
      maritalStatus: 'Married',
      employmentType: 'Salaried',
      employerName: 'Beta Corp',
      jobTitle: 'Analyst',
      industry: 'Finance',
      yearsEmployed: '3',
      monthlyIncome: 45000,
      addressLine1: '12 MG Road',
      city: 'Jaipur',
      state: 'Rajasthan',
      pinCode: '302001',
    },
    existingLoans: [
      {
        lender: 'SBI',
        loanType: 'Personal Loan',
        accountNumber: '9988',
        originalAmount: 200000,
        outstandingAmount: 80000,
        emi: 6500,
        tenureLeft: '12 months',
      },
    ],
  },
  documents: [
    { document_type: 'pan_card' },
    { document_type: 'aadhaar' },
    { document_type: 'bank_statement' },
    { document_type: 'salary_slip' },
  ],
  consents: [
    { consent_type: 'processing', is_granted: true },
    { consent_type: 'whatsapp', is_granted: true },
    { consent_type: 'email', is_granted: true },
  ],
};

const pdf = await buildBankLoanApplicationFormPdf(sample);
const outDir = resolve(process.cwd(), 'tmp');
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, 'Rfincare_Bank_Loan_Application_Form-TEST.pdf');
writeFileSync(outPath, pdf);
console.log('OK generated:', outPath, `(${pdf.length} bytes)`);
