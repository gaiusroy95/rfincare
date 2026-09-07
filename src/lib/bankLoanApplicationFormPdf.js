import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN_X = 40;
const MARGIN_TOP = 50;
const MARGIN_BOTTOM = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function field(data, ...keys) {
  for (const key of keys) {
    if (data?.[key] != null && String(data[key]).trim() !== '') return data[key];
  }
  return '';
}

function dash(value) {
  if (value == null || value === '') return '—';
  return String(value).trim() || '—';
}

function formatInr(value) {
  const n = Number(String(value ?? '').replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return '—';
  return `Rs. ${Math.round(n).toLocaleString('en-IN')}`;
}

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function yesNo(value) {
  if (value === true || value === 'yes' || value === 'Yes' || value === 1 || value === '1') return 'Yes';
  if (value === false || value === 'no' || value === 'No' || value === 0 || value === '0') return 'No';
  return value == null || value === '' ? '—' : String(value);
}

function last4(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '—';
  return digits.slice(-4);
}

function fullName(data, row) {
  const parts = [
    field(data, 'title', 'title'),
    field(data, 'firstName', 'first_name'),
    field(data, 'middleName', 'middle_name'),
    field(data, 'lastName', 'last_name'),
  ].filter(Boolean);
  if (parts.length) return parts.join(' ');
  return row?.customer_full_name || '—';
}

function addressLine(data, prefix = '') {
  const p = (camel, snake) => field(data, prefix + camel, prefix + snake);
  const parts = [
    p('addressLine1', 'address_line1') || field(data, 'addressLine1', 'address_line1'),
    p('addressLine2', 'address_line2') || field(data, 'addressLine2', 'address_line2'),
  ].filter(Boolean);
  return parts.join(', ') || '—';
}

function coApplicant(data) {
  const raw = data?.coApplicant || data?.co_applicant;
  if (!raw || typeof raw !== 'object') return null;
  return raw;
}

function existingLoans(data) {
  const list = data?.existingLoans || data?.existing_loans;
  return Array.isArray(list) ? list : [];
}

function resolveBlankTemplatePath() {
  const candidates = [
    resolve(__dirname, '../../assets/forms/Rfincare_Bank_Loan_Application_Form.pdf'),
    resolve(process.cwd(), 'assets/forms/Rfincare_Bank_Loan_Application_Form.pdf'),
    resolve(process.cwd(), 'backend/assets/forms/Rfincare_Bank_Loan_Application_Form.pdf'),
  ];
  return candidates.find((p) => existsSync(p)) || null;
}

/**
 * Build application field map used to fill the official Rfincare Bank Loan Application Form.
 */
export function buildBankLoanApplicationValues({ row, data: rawData, documents = [], consents = [] }) {
  const data = parseJson(rawData);
  const co = coApplicant(data);
  const loans = existingLoans(data);
  const monthlyIncome = field(data, 'monthlyIncome', 'monthly_income');
  const annualIncome = field(data, 'annualIncome', 'annual_income')
    || (monthlyIncome ? Number(monthlyIncome) * 12 : '');
  const loanAmount = field(
    data,
    'loanAmount',
    'loan_amount',
    'requestedLoanAmount',
    'requested_loan_amount',
  );
  const totalEmi = field(data, 'monthlyDebtPayments', 'monthly_debt_payments');
  const submittedAt = row?.submitted_at || row?.created_at || new Date();

  const docTypes = new Set((documents || []).map((d) => String(d.document_type || d.documentType || '').toLowerCase()));
  const hasDoc = (...keys) => keys.some((k) => [...docTypes].some((t) => t.includes(k)));

  return {
    applicationNumber: row?.application_number || row?.id || '—',
    applicationDate: formatDate(submittedAt),
    agentCode: row?.sourced_agent_code || field(data, 'sourcedAgentCode', 'sourced_agent_code') || '—',
    preferredBranch: field(data, 'preferredBranch', 'preferred_branch', 'city', 'city') || '—',
    loanProduct: field(data, 'loan_type_label', 'loanTypeLabel', 'loan_type', 'loanType', 'loanPurpose', 'loan_purpose')
      || row?.loan_type
      || '—',
    purposeOfLoan: field(data, 'loanPurpose', 'loan_purpose', 'loan_type', 'loanType') || '—',
    requestedAmount: formatInr(loanAmount),
    preferredTenure: field(data, 'preferredTenure', 'preferred_tenure', 'tenure') || '—',
    preferredLender: field(data, 'preferredBankName', 'preferred_bank_name') || '—',
    existingCustomer: field(data, 'existingCustomer', 'existing_customer') || '—',

    applicantName: fullName(data, row),
    fatherSpouseName: field(data, 'fatherName', 'father_name', 'spouseName', 'spouse_name', 'motherName', 'mother_name') || '—',
    dateOfBirth: formatDate(field(data, 'dateOfBirth', 'date_of_birth')),
    gender: dash(field(data, 'gender', 'gender')),
    maritalStatus: dash(field(data, 'maritalStatus', 'marital_status')),
    dependents: dash(field(data, 'numberOfDependents', 'number_of_dependents', 'dependents')),
    nationality: dash(field(data, 'nationality', 'nationality') || 'Indian'),
    residentialStatus: dash(field(data, 'residentialStatus', 'residential_status') || 'Resident'),
    pan: dash(field(data, 'pan', 'pan_number', 'panNumber')),
    aadhaarLast4: last4(field(data, 'aadhaar', 'aadhaar_number', 'aadhaarNumber')),

    mobile: dash(field(data, 'phone', 'phone', 'mobile', 'mobile')),
    altMobile: dash(field(data, 'alternatePhone', 'alternate_phone', 'altPhone')),
    email: dash(field(data, 'email', 'email') || row?.customer_email),
    currentAddress: addressLine(data),
    city: dash(field(data, 'city', 'city')),
    district: dash(field(data, 'district', 'district')),
    state: dash(field(data, 'state', 'state')),
    pinCode: dash(field(data, 'pinCode', 'pin_code')),
    yearsAtAddress: dash(field(data, 'yearsAtAddress', 'years_at_address')),
    permanentAddress: dash(
      field(data, 'permanentAddress', 'permanent_address')
      || addressLine(data),
    ),
    residenceType: dash(field(data, 'residenceType', 'residence_type')),

    occupationType: dash(field(data, 'employmentType', 'employment_type')),
    employerName: dash(field(data, 'employerName', 'employer_name')),
    designation: dash(field(data, 'jobTitle', 'job_title')),
    industry: dash(field(data, 'industry', 'industry')),
    officeAddress: dash(field(data, 'officeAddress', 'office_address')),
    yearsEmployed: dash(field(data, 'yearsEmployed', 'years_employed')),
    totalExperience: dash(field(data, 'totalExperience', 'total_experience', 'yearsEmployed', 'years_employed')),
    businessConstitution: dash(field(data, 'businessConstitution', 'business_constitution')),
    officialContact: dash(field(data, 'employerPhone', 'employer_phone')),
    registrationNo: dash(field(data, 'udyamNumber', 'udyam_number', 'gstNumber', 'gst_number')),

    grossMonthly: formatInr(monthlyIncome),
    grossAnnual: formatInr(annualIncome),
    netMonthly: formatInr(field(data, 'netMonthlyIncome', 'net_monthly_income') || monthlyIncome),
    netAnnual: formatInr(field(data, 'netAnnualIncome', 'net_annual_income') || annualIncome),
    otherIncomeMonthly: formatInr(field(data, 'otherIncome', 'other_income', 'retirementIncome', 'retirement_income')),
    otherIncomeAnnual: '—',
    householdExpenses: formatInr(field(data, 'householdExpenses', 'household_expenses', 'monthlyRent', 'monthly_rent')),
    existingEmi: formatInr(totalEmi),
    creditCardDues: formatInr(field(data, 'creditCardOutstanding1', 'credit_card_outstanding_1')),
    otherIncomeSource: dash(field(data, 'otherIncomeSource', 'other_income_source')),
    itrFiled: dash(field(data, 'itrFiled', 'itr_filed')),
    itrYear: dash(field(data, 'itrYear', 'itr_year', 'assessmentYear')),
    cibilScore: dash(field(data, 'creditScoreRange', 'credit_score_range', 'cibilScore', 'cibil_score')),
    primaryBank: dash(field(data, 'bankName', 'bank_name', 'primaryBank', 'primary_bank')),
    accountLast4: last4(field(data, 'accountNumber', 'account_number', 'bankAccountNumber')),
    ifsc: dash(field(data, 'ifsc', 'ifsc_code', 'ifscCode')),
    avgMonthlyCredit: formatInr(field(data, 'averageMonthlyCredit', 'average_monthly_credit')),

    coApplicantName: co
      ? dash([field(co, 'firstName', 'first_name'), field(co, 'lastName', 'last_name')].filter(Boolean).join(' '))
      : '—',
    coRelationship: dash(co && field(co, 'relationship', 'relationship')),
    coFatherName: '—',
    coDob: formatDate(co && field(co, 'dateOfBirth', 'date_of_birth')),
    coGender: dash(co && field(co, 'gender', 'gender')),
    coMarital: dash(co && field(co, 'maritalStatus', 'marital_status')),
    coDependents: '—',
    coNationality: co ? 'Indian' : '—',
    coResidential: co ? 'Resident' : '—',
    coPan: dash(co && (field(co, 'pan', 'pan_number') || field(co, 'panNumber', 'pan_number'))),
    coAadhaarLast4: last4(co && (field(co, 'aadhaar', 'aadhaar_number') || field(co, 'aadhaarNumber', 'aadhaar_number'))),
    coMobile: dash(co && field(co, 'phone', 'phone')),
    coAltMobile: '—',
    coEmail: dash(co && field(co, 'email', 'email')),
    coAddress: co ? addressLine(co) : '—',
    coCity: dash(co && field(co, 'city', 'city')),
    coDistrict: dash(co && field(co, 'district', 'district')),
    coState: dash(co && field(co, 'state', 'state')),
    coPin: dash(co && field(co, 'pinCode', 'pin_code')),
    coYearsAtAddress: '—',
    coPermanentAddress: '—',
    coResidenceType: '—',
    coOccupation: dash(co && field(co, 'employmentType', 'employment_type')),
    coEmployer: dash(co && field(co, 'employerName', 'employer_name')),
    coDesignation: dash(co && field(co, 'jobTitle', 'job_title')),
    coIndustry: dash(co && field(co, 'industry', 'industry')),
    coOfficeAddress: '—',
    coYearsEmployed: dash(co && field(co, 'yearsEmployed', 'years_employed')),
    coGrossMonthly: formatInr(co && field(co, 'monthlyIncome', 'monthly_income')),
    coNetMonthly: formatInr(co && field(co, 'monthlyIncome', 'monthly_income')),
    coOtherIncome: '—',
    coExistingEmi: '—',

    endUse: dash(field(data, 'loanPurpose', 'loan_purpose')),
    downPayment: formatInr(field(data, 'downPayment', 'down_payment')),
    preferredEmi: formatInr(field(data, 'preferredEmi', 'preferred_emi')),
    repaymentBank: dash(field(data, 'bankName', 'bank_name', 'repaymentBank')),
    repaymentFrequency: dash(field(data, 'repaymentFrequency', 'repayment_frequency') || 'Monthly'),
    repaymentSource: dash(field(data, 'repaymentSource', 'repayment_source') || 'Salary / Business income'),
    collateral: dash(field(data, 'collateral', 'security', 'propertyType', 'property_type')),
    assetValue: formatInr(field(data, 'propertyValue', 'property_value', 'assetValue')),

    loans: loans.slice(0, 4).map((loan) => ({
      lender: dash(loan.lender || loan.bank_name || loan.bankName),
      type: dash(loan.loan_type || loan.loanType),
      last4: last4(loan.account_number || loan.accountNumber),
      original: formatInr(loan.original_amount || loan.originalAmount),
      outstanding: formatInr(loan.outstanding_amount || loan.outstandingAmount),
      emi: formatInr(loan.emi_amount || loan.emiAmount),
      tenureLeft: dash(loan.tenure_left || loan.tenureLeft),
      security: dash(loan.security || loan.collateral),
    })),

    propertyType: dash(field(data, 'propertyType', 'property_type')),
    ownershipStatus: dash(field(data, 'ownershipStatus', 'ownership_status')),
    ownerNames: dash(field(data, 'propertyOwnerName', 'property_owner_name') || fullName(data, row)),
    propertyAddress: dash(field(data, 'propertyAddress', 'property_address')),
    propertyCity: dash(field(data, 'propertyCity', 'property_city') || field(data, 'city', 'city')),
    propertyState: dash(field(data, 'propertyState', 'property_state') || field(data, 'state', 'state')),
    propertyPin: dash(field(data, 'propertyPin', 'property_pin') || field(data, 'pinCode', 'pin_code')),
    marketValue: formatInr(field(data, 'propertyValue', 'property_value')),
    purchaseCost: formatInr(field(data, 'purchaseCost', 'purchase_cost')),
    existingCharge: yesNo(field(data, 'existingMortgage', 'existing_mortgage')),

    docs: {
      pan: hasDoc('pan'),
      idProof: hasDoc('aadhaar', 'identity', 'address'),
      photo: hasDoc('photo', 'customer_photo'),
      bank: hasDoc('bank'),
      salary: hasDoc('salary', 'income'),
      itr: hasDoc('itr', 'form_16', 'financial'),
      employment: hasDoc('employment', 'business'),
      property: hasDoc('property', 'collateral'),
      loanStmt: hasDoc('loan_statement', 'closure'),
      other: documents?.length > 0,
    },

    consentProcessing: consents?.length || field(data, 'agreeTerms', 'agree_terms') ? 'Yes' : '—',
    consentPhone: yesNo(field(data, 'consentWhatsapp', 'consent_whatsapp') || true),
    consentSmsEmail: yesNo(field(data, 'consentEmail', 'consent_email') || true),
    consentFuture: yesNo(field(data, 'consentMarketing', 'consent_marketing')),

    certifyAccuracy: yesNo(field(data, 'certifyAccuracy', 'certify_accuracy')),
    authorizeCredit: yesNo(field(data, 'authorizeCredit', 'authorize_credit')),
    agreeTerms: yesNo(field(data, 'agreeTerms', 'agree_terms')),
    signatureName: dash(field(data, 'signatureName', 'signature_name') || fullName(data, row)),
    signatureDate: formatDate(field(data, 'signatureSignedAt', 'signature_signed_at') || submittedAt),
    signaturePlace: dash(field(data, 'city', 'city')),
    status: dash(row?.status),
    recommendedLender: dash(field(data, 'preferredBankName', 'preferred_bank_name')),
    eligibilityAmount: formatInr(field(data, 'eligibleAmount', 'eligible_amount')),
  };
}

function wrapText(text, font, size, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return ['—'];
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : ['—'];
}

/**
 * Generate filled Rfincare Bank Loan Application Form PDF (official layout, values filled).
 */
export async function buildBankLoanApplicationFormPdf(payload) {
  const values = buildBankLoanApplicationValues(payload);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const colors = {
    ink: rgb(0.1, 0.12, 0.16),
    muted: rgb(0.35, 0.38, 0.42),
    line: rgb(0.75, 0.78, 0.82),
    header: rgb(0.05, 0.25, 0.45),
    box: rgb(0.96, 0.97, 0.98),
    accent: rgb(0.0, 0.45, 0.55),
  };

  let page = null;
  let y = 0;
  let pageNo = 0;

  const ensurePage = () => {
    if (!page || y < MARGIN_BOTTOM + 40) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      pageNo += 1;
      y = PAGE_HEIGHT - MARGIN_TOP;
      drawHeader();
    }
  };

  const drawHeader = () => {
    page.drawText('BANK LOAN APPLICATION FORM', {
      x: MARGIN_X,
      y,
      size: 14,
      font: fontBold,
      color: colors.header,
    });
    y -= 14;
    page.drawText('Application Processing Support | Customer + Co-Applicant', {
      x: MARGIN_X,
      y,
      size: 8,
      font,
      color: colors.muted,
    });
    y -= 11;
    page.drawText(
      `Rfincare | Application processing assistance only | Not a lender | Page ${pageNo}`,
      {
        x: MARGIN_X,
        y,
        size: 8,
        font,
        color: colors.muted,
      },
    );
    y -= 8;
    page.drawLine({
      start: { x: MARGIN_X, y },
      end: { x: PAGE_WIDTH - MARGIN_X, y },
      thickness: 1,
      color: colors.accent,
    });
    y -= 16;
  };

  const drawFooter = () => {
    const pages = doc.getPages();
    pages.forEach((p, idx) => {
      p.drawText(
        `End of Form page ${idx + 1} of ${pages.length} | Please attach lender-specific disclosures when issued.`,
        {
          x: MARGIN_X,
          y: 22,
          size: 7,
          font,
          color: colors.muted,
        },
      );
    });
  };

  const text = (str, { bold = false, size = 9, color = colors.ink, indent = 0 } = {}) => {
    ensurePage();
    const useFont = bold ? fontBold : font;
    const lines = wrapText(str, useFont, size, CONTENT_WIDTH - indent);
    for (const line of lines) {
      ensurePage();
      page.drawText(line, {
        x: MARGIN_X + indent,
        y,
        size,
        font: useFont,
        color,
      });
      y -= size + 3;
    }
  };

  const section = (title) => {
    ensurePage();
    if (y < MARGIN_BOTTOM + 80) {
      page = null;
      ensurePage();
    }
    y -= 4;
    page.drawRectangle({
      x: MARGIN_X,
      y: y - 4,
      width: CONTENT_WIDTH,
      height: 16,
      color: colors.box,
    });
    page.drawText(title, {
      x: MARGIN_X + 4,
      y,
      size: 10,
      font: fontBold,
      color: colors.header,
    });
    y -= 18;
  };

  const kv = (label, value, { widthRatio = 0.5 } = {}) => {
    ensurePage();
    const colW = CONTENT_WIDTH * widthRatio;
    const labelText = `${label}:`;
    const valueText = dash(value);
    page.drawText(labelText, {
      x: MARGIN_X,
      y,
      size: 8,
      font: fontBold,
      color: colors.muted,
    });
    const labelW = fontBold.widthOfTextAtSize(labelText, 8) + 6;
    const valueLines = wrapText(valueText, font, 9, Math.max(80, colW - labelW - 4));
    valueLines.forEach((line, idx) => {
      if (idx > 0) {
        y -= 12;
        ensurePage();
      }
      page.drawText(line, {
        x: MARGIN_X + labelW,
        y,
        size: 9,
        font,
        color: colors.ink,
      });
    });
  };

  const pair = (leftLabel, leftValue, rightLabel, rightValue) => {
    ensurePage();
    const gap = 16;
    const colW = (CONTENT_WIDTH - gap) / 2;
    const rowY = y;

    const drawCol = (x, label, value) => {
      page.drawText(`${label}:`, {
        x,
        y: rowY,
        size: 8,
        font: fontBold,
        color: colors.muted,
      });
      const lw = fontBold.widthOfTextAtSize(`${label}:`, 8) + 4;
      const lines = wrapText(dash(value), font, 9, colW - lw);
      lines.forEach((line, idx) => {
        page.drawText(line, {
          x: x + lw,
          y: rowY - idx * 11,
          size: 9,
          font,
          color: colors.ink,
        });
      });
      return lines.length;
    };

    const leftLines = drawCol(MARGIN_X, leftLabel, leftValue);
    const rightLines = drawCol(MARGIN_X + colW + gap, rightLabel, rightValue);
    y -= Math.max(leftLines, rightLines) * 11 + 4;
  };

  const note = (str) => text(str, { size: 7.5, color: colors.muted });

  // ——— Page content matching official form sections ———
  ensurePage();
  text('Comprehensive Application, KYC, Income, Banking & Consent Form', {
    bold: true,
    size: 10,
  });
  note(
    'IMPORTANT ROLE DISCLOSURE: Rfincare acts as an application-processing and credit-facilitation channel for participating lenders and is not the lender. Loan sanction, pricing, tenure, documentation, verification and disbursement are decided solely by the individual bank/NBFC/lender.',
  );
  note(
    'PLEASE NOTE: This form is an application/processing document. It is not a sanction letter, loan agreement, promise of approval, or guarantee of disbursement.',
  );

  section('1. Application Identification & Loan Requirement');
  pair('Application / Reference No.', values.applicationNumber, 'Application Date', values.applicationDate);
  pair('Lead / Agent Code', values.agentCode, 'Preferred Branch / Location', values.preferredBranch);
  pair('Loan Product', values.loanProduct, 'Purpose of Loan', values.purposeOfLoan);
  pair('Requested Loan Amount (Rs.)', values.requestedAmount, 'Preferred Tenure', values.preferredTenure);
  pair('Preferred Lender / Bank', values.preferredLender, 'Existing Rfincare Customer?', values.existingCustomer);
  note(
    'CUSTOMER CHOICE: The applicant may choose a participating lender where available. Recommendations are subject to final lender eligibility, verification and underwriting.',
  );

  section('2. Applicant - Personal & Identity Details');
  pair('Full Legal Name (as per PAN)', values.applicantName, 'Father / Spouse / Mother Name', values.fatherSpouseName);
  pair('Date of Birth', values.dateOfBirth, 'Gender', values.gender);
  pair('Marital Status', values.maritalStatus, 'Number of Dependents', values.dependents);
  pair('Nationality', values.nationality, 'Residential Status', values.residentialStatus);
  pair('PAN', values.pan, 'Aadhaar / VID (last 4 digits)', values.aadhaarLast4);

  section('3. Applicant - Contact & Address');
  pair('Mobile Number', values.mobile, 'Alternate Mobile Number', values.altMobile);
  kv('Email ID', values.email, { widthRatio: 1 });
  y -= 2;
  kv('Current Address', values.currentAddress, { widthRatio: 1 });
  y -= 2;
  pair('City / District', `${values.city} / ${values.district}`, 'State', values.state);
  pair('PIN Code', values.pinCode, 'Years at Current Address', values.yearsAtAddress);
  kv('Permanent Address', values.permanentAddress, { widthRatio: 1 });
  y -= 2;
  kv('Owned / Rented / Family', values.residenceType, { widthRatio: 1 });
  y -= 4;

  section('4. Applicant - Employment / Business Profile');
  pair('Occupation Type', values.occupationType, 'Employer / Business Name', values.employerName);
  pair('Designation / Nature of Business', values.designation, 'Industry / Sector', values.industry);
  kv('Office / Business Address', values.officeAddress, { widthRatio: 1 });
  y -= 2;
  pair('Years in Current Employment / Business', values.yearsEmployed, 'Total Work Experience', values.totalExperience);
  pair('Business Constitution', values.businessConstitution, 'Official Contact Number', values.officialContact);
  kv('Udyam / GST / Other Registration', values.registrationNo, { widthRatio: 1 });
  y -= 4;

  section('5. Applicant - Income & Financial Profile');
  text('Income / Expense Item          Monthly (Rs.)          Annual (Rs.)', { bold: true, size: 8, color: colors.muted });
  text(`Gross Income                   ${values.grossMonthly.padEnd(20)} ${values.grossAnnual}`, { size: 8 });
  text(`Net / Take-home Income         ${values.netMonthly.padEnd(20)} ${values.netAnnual}`, { size: 8 });
  text(`Other Income                   ${values.otherIncomeMonthly.padEnd(20)} ${values.otherIncomeAnnual}`, { size: 8 });
  text(`Household / Personal Expenses  ${values.householdExpenses.padEnd(20)} —`, { size: 8 });
  text(`Existing EMI / Loan Obligations ${values.existingEmi.padEnd(19)} —`, { size: 8 });
  text(`Credit Card / Other Dues       ${values.creditCardDues.padEnd(20)} —`, { size: 8 });
  pair('Source of Other Income', values.otherIncomeSource, 'Income Tax Return Filed?', values.itrFiled);
  pair('ITR / Assessment Year', values.itrYear, 'CIBIL / Credit Score (if known)', values.cibilScore);
  pair('Primary Bank Account', values.primaryBank, 'Bank Account Number (last 4)', values.accountLast4);
  pair('IFSC', values.ifsc, 'Average Monthly Bank Credit', values.avgMonthlyCredit);
  note(
    'DOCUMENT SUPPORT: Attach income evidence requested by the lender (salary slips, bank statements, ITRs, GST returns, audited financials, or other lender-specific records).',
  );

  section('6. Co-Applicant - Personal & Identity Details');
  pair('Full Legal Name (as per PAN)', values.coApplicantName, 'Relationship with Applicant', values.coRelationship);
  pair('Father / Spouse / Mother Name', values.coFatherName, 'Date of Birth', values.coDob);
  pair('Gender', values.coGender, 'Marital Status', values.coMarital);
  pair('Number of Dependents', values.coDependents, 'Nationality', values.coNationality);
  pair('Residential Status', values.coResidential, 'PAN', values.coPan);
  kv('Aadhaar / VID (last 4 digits)', values.coAadhaarLast4, { widthRatio: 1 });
  y -= 4;

  section('7. Co-Applicant - Contact & Address');
  pair('Mobile Number', values.coMobile, 'Alternate Mobile Number', values.coAltMobile);
  kv('Email ID', values.coEmail, { widthRatio: 1 });
  y -= 2;
  kv('Current Address', values.coAddress, { widthRatio: 1 });
  y -= 2;
  pair('City / District', `${values.coCity} / ${values.coDistrict}`, 'State', values.coState);
  pair('PIN Code', values.coPin, 'Years at Current Address', values.coYearsAtAddress);
  kv('Permanent Address', values.coPermanentAddress, { widthRatio: 1 });
  y -= 2;
  kv('Owned / Rented / Family', values.coResidenceType, { widthRatio: 1 });
  y -= 4;

  section('8. Co-Applicant - Employment / Business / Income');
  pair('Occupation Type', values.coOccupation, 'Employer / Business Name', values.coEmployer);
  pair('Designation / Nature of Business', values.coDesignation, 'Industry / Sector', values.coIndustry);
  kv('Office / Business Address', values.coOfficeAddress, { widthRatio: 1 });
  y -= 2;
  pair('Years in Current Employment / Business', values.coYearsEmployed, 'Gross Monthly Income', values.coGrossMonthly);
  pair('Net / Take-home Monthly Income', values.coNetMonthly, 'Other Income', values.coOtherIncome);
  kv('Existing EMI / Loan Obligations', values.coExistingEmi, { widthRatio: 1 });
  y -= 4;

  section('9. Loan Requirement & Repayment Details');
  pair('Purpose / End Use of Loan', values.endUse, 'Loan Amount Requested (Rs.)', values.requestedAmount);
  pair('Down Payment / Own Contribution', values.downPayment, 'Preferred Tenure', values.preferredTenure);
  pair('Preferred EMI Range', values.preferredEmi, 'Repayment Account Bank', values.repaymentBank);
  pair('Repayment Frequency', values.repaymentFrequency, 'Expected Source of Repayment', values.repaymentSource);
  pair('Security / Collateral Offered', values.collateral, 'Property / Asset Value', values.assetValue);

  section('10. Existing Loans, Credit Facilities & Liabilities');
  text('Lender / Bank | Loan Type | Last 4 | Original | Outstanding | EMI | Tenure Left | Security', {
    bold: true,
    size: 7.5,
    color: colors.muted,
  });
  if (!values.loans.length) {
    text('No existing loans reported.', { size: 8 });
  } else {
    values.loans.forEach((loan, idx) => {
      text(
        `${idx + 1}. ${loan.lender} | ${loan.type} | ${loan.last4} | ${loan.original} | ${loan.outstanding} | ${loan.emi} | ${loan.tenureLeft} | ${loan.security}`,
        { size: 8 },
      );
    });
  }

  section('11. Banking Details & Account Conduct');
  pair('Bank / Branch', values.primaryBank, 'Account Type', 'Savings / Current');
  pair('Last 4 Digits', values.accountLast4, 'IFSC', values.ifsc);
  note(
    'BANKING AUTHORITY: The applicant authorises relevant lenders, their authorised service providers, and Rfincare (to the extent lawfully permitted and necessary for processing) to verify the information submitted.',
  );

  section('12. Property / Collateral / Asset Details (where applicable)');
  pair('Asset / Property Type', values.propertyType, 'Ownership Status', values.ownershipStatus);
  pair('Owner Name(s)', values.ownerNames, 'Property Address', values.propertyAddress);
  pair('City / District', values.propertyCity, 'State', values.propertyState);
  pair('PIN Code', values.propertyPin, 'Approx. Market Value (Rs.)', values.marketValue);
  pair('Approx. Purchase / Construction Cost', values.purchaseCost, 'Existing Charge / Mortgage?', values.existingCharge);

  section('13. Document Checklist - Applicant & Co-Applicant');
  const mark = (ok) => (ok ? '[X]' : '[ ]');
  text(`PAN / PAN acknowledgement                 Applicant ${mark(values.docs.pan)}   Co-Applicant [ ]`, { size: 8 });
  text(`Identity / Address Proof                  Applicant ${mark(values.docs.idProof)}   Co-Applicant [ ]`, { size: 8 });
  text(`Photograph                                Applicant ${mark(values.docs.photo)}   Co-Applicant [ ]`, { size: 8 });
  text(`Bank Statement                            Applicant ${mark(values.docs.bank)}   Co-Applicant [ ]`, { size: 8 });
  text(`Salary Slips / Income Proof               Applicant ${mark(values.docs.salary)}   Co-Applicant [ ]`, { size: 8 });
  text(`ITR / Form 16 / Financials                Applicant ${mark(values.docs.itr)}   Co-Applicant [ ]`, { size: 8 });
  text(`Employment / Business Proof               Applicant ${mark(values.docs.employment)}   Co-Applicant [ ]`, { size: 8 });
  text(`Property / Collateral Documents           Applicant ${mark(values.docs.property)}   Co-Applicant [ ]`, { size: 8 });
  text(`Existing Loan Statements / Closure Proof  Applicant ${mark(values.docs.loanStmt)}   Co-Applicant [ ]`, { size: 8 });
  text(`Other lender-specific documents           Applicant ${mark(values.docs.other)}   Co-Applicant [ ]`, { size: 8 });

  section('14. Applicant Declarations & Authorisations');
  note('• I/We confirm that the information and documents provided in this application are true, complete and accurate to the best of my/our knowledge and belief.');
  note('• I/We understand that the lender may independently verify all information, documents, bank records, credit information, employment/business information, property records and other relevant details.');
  note('• I/We understand that Rfincare does not itself sanction, disburse, price or guarantee the loan. Any approval is solely the decision of the selected lender.');
  note('• I/We authorise sharing of the submitted application and relevant documents with the lender(s) selected or considered for my/our application, to the extent necessary for processing.');
  note('• I/We will promptly inform Rfincare/lender of any material change in employment, income, address, liabilities or other information relevant to the application.');
  pair('Certify accuracy', values.certifyAccuracy, 'Authorize credit check', values.authorizeCredit);
  kv('Agree to terms', values.agreeTerms, { widthRatio: 1 });
  y -= 4;

  section('15. Truthfulness, Forgery & Fraud Warning');
  note(
    'IMPORTANT LEGAL WARNING: Submitting false, forged, altered, fabricated or misleading information or documents may result in rejection/cancellation of the application and may expose the applicant(s) to civil or criminal consequences under applicable Indian law.',
  );

  section('16. Customer Consent & Communication Preferences');
  pair('Application processing and lender sharing', values.consentProcessing, 'Phone / WhatsApp updates', values.consentPhone);
  pair('SMS / Email status updates', values.consentSmsEmail, 'Future product / service communication', values.consentFuture);

  section('17. Lender / Application Processing Office Use');
  pair('Recommended Lender / Bank', values.recommendedLender, 'Loan Product / Variant', values.loanProduct);
  pair('Eligibility Amount Indicated (Rs.)', values.eligibilityAmount, 'Final Requested Amount (Rs.)', values.requestedAmount);
  pair('Application Status', values.status, 'Internal Application No.', values.applicationNumber);

  section('18. Final Acknowledgement');
  note(
    'ACKNOWLEDGEMENT: By signing below, I/We confirm that the application has been completed by me/us or under my/our instructions, that the information supplied is accurate to the best of my/our knowledge, and that I/we have read and understood the disclosures regarding Rfincare\'s non-lending role and the lender\'s independent approval process.',
  );
  pair('Applicant Signature / Name', values.signatureName, 'Co-Applicant Signature / Name', values.coApplicantName);
  pair('Date', values.signatureDate, 'Place', values.signaturePlace);
  pair('Applicant Full Name', values.applicantName, 'Co-Applicant Full Name', values.coApplicantName);

  section('19. Rfincare Role & Lender Decision Disclaimer');
  note(
    'Rfincare is an authorised application-processing / channel partner of participating lenders, where applicable. Rfincare is not the lender and does not itself sanction, price or guarantee the loan. The selected lender alone decides approval, terms and disbursement, subject to its policies, verification and applicable law.',
  );
  note(
    'FALSE INFORMATION / DOCUMENTS: False, forged, altered, fabricated or materially misleading information/documents may lead to rejection/cancellation and may expose the applicant(s) to civil or criminal action under applicable Indian law.',
  );
  text('End of Form | Please attach lender-specific KFS / product disclosures / sanction documents separately when issued.', {
    bold: true,
    size: 8,
  });

  drawFooter();
  return Buffer.from(await doc.save());
}

export function getBlankBankLoanApplicationFormPath() {
  return resolveBlankTemplatePath();
}
