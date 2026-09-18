import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  if (value == null || value === '') return '';
  return String(value).trim();
}

function formatInr(value) {
  const n = Number(String(value ?? '').replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return '';
  return Math.round(n).toLocaleString('en-IN');
}

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function yesNo(value) {
  if (value === true || value === 'yes' || value === 'Yes' || value === 1 || value === '1') return 'Yes';
  if (value === false || value === 'no' || value === 'No' || value === 0 || value === '0') return 'No';
  return '';
}

function last4(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.slice(-4);
}

function fullName(data, row) {
  const parts = [
    field(data, 'title'),
    field(data, 'firstName', 'first_name'),
    field(data, 'middleName', 'middle_name'),
    field(data, 'lastName', 'last_name'),
  ].filter(Boolean);
  if (parts.length) return parts.join(' ');
  return row?.customer_full_name || '';
}

function addressLine(data) {
  const parts = [
    field(data, 'addressLine1', 'address_line1'),
    field(data, 'addressLine2', 'address_line2'),
  ].filter(Boolean);
  return parts.join(', ');
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

export function resolveBlankTemplatePath() {
  const candidates = [
    resolve(__dirname, '../../assets/forms/Rfincare_Bank_Loan_Application_Form.pdf'),
    resolve(process.cwd(), 'assets/forms/Rfincare_Bank_Loan_Application_Form.pdf'),
    resolve(process.cwd(), 'backend/assets/forms/Rfincare_Bank_Loan_Application_Form.pdf'),
    resolve(process.cwd(), 'docs/Need This Rfincare_Bank_Loan_Application_Form.pdf'),
    resolve(__dirname, '../../../docs/Need This Rfincare_Bank_Loan_Application_Form.pdf'),
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

  const docTypes = new Set(
    (documents || []).map((d) => String(d.document_type || d.documentType || '').toLowerCase()),
  );
  const hasDoc = (...keys) => keys.some((k) => [...docTypes].some((t) => t.includes(k)));

  return {
    applicationNumber: row?.application_number || row?.id || '',
    applicationDate: formatDate(submittedAt),
    agentCode: row?.sourced_agent_code || field(data, 'sourcedAgentCode', 'sourced_agent_code') || '',
    preferredBranch: field(data, 'preferredBranch', 'preferred_branch', 'city') || '',
    loanProduct:
      field(data, 'loan_type_label', 'loanTypeLabel', 'loan_type', 'loanType', 'loanPurpose', 'loan_purpose')
      || row?.loan_type
      || '',
    purposeOfLoan: field(data, 'loanPurpose', 'loan_purpose', 'loan_type', 'loanType') || '',
    requestedAmount: formatInr(loanAmount),
    preferredTenure: field(data, 'preferredTenure', 'preferred_tenure', 'tenure') || '',
    preferredLender: field(data, 'preferredBankName', 'preferred_bank_name') || '',
    existingCustomer: field(data, 'existingCustomer', 'existing_customer') || '',

    applicantName: fullName(data, row),
    fatherSpouseName:
      field(data, 'fatherName', 'father_name', 'spouseName', 'spouse_name', 'motherName', 'mother_name') || '',
    dateOfBirth: formatDate(field(data, 'dateOfBirth', 'date_of_birth')),
    gender: dash(field(data, 'gender')),
    maritalStatus: dash(field(data, 'maritalStatus', 'marital_status')),
    dependents: dash(field(data, 'numberOfDependents', 'number_of_dependents', 'dependents')),
    nationality: dash(field(data, 'nationality') || 'Indian'),
    residentialStatus: dash(field(data, 'residentialStatus', 'residential_status') || 'Resident'),
    pan: dash(field(data, 'pan', 'pan_number', 'panNumber')),
    aadhaarLast4: last4(field(data, 'aadhaar', 'aadhaar_number', 'aadhaarNumber')),

    mobile: dash(field(data, 'phone', 'mobile') || row?.customer_phone),
    altMobile: dash(field(data, 'alternatePhone', 'alternate_phone', 'altPhone')),
    email: dash(field(data, 'email') || row?.customer_email),
    currentAddress: addressLine(data),
    city: dash(field(data, 'city')),
    district: dash(field(data, 'district')),
    state: dash(field(data, 'state')),
    pinCode: dash(field(data, 'pinCode', 'pin_code')),
    yearsAtAddress: dash(field(data, 'yearsAtAddress', 'years_at_address')),
    permanentAddress: dash(field(data, 'permanentAddress', 'permanent_address') || addressLine(data)),
    residenceType: dash(field(data, 'residenceType', 'residence_type')),

    occupationType: dash(field(data, 'employmentType', 'employment_type')),
    employerName: dash(field(data, 'employerName', 'employer_name')),
    designation: dash(field(data, 'jobTitle', 'job_title')),
    industry: dash(field(data, 'industry')),
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
    otherIncomeMonthly: formatInr(field(data, 'otherIncome', 'other_income', 'extraIncome', 'extra_income')),
    householdExpenses: formatInr(field(data, 'householdExpenses', 'household_expenses', 'monthlyRent', 'monthly_rent')),
    existingEmi: formatInr(totalEmi),
    creditCardDues: formatInr(field(data, 'creditCardOutstanding1', 'credit_card_outstanding_1')),
    otherIncomeSource: dash(field(data, 'otherIncomeSource', 'other_income_source', 'extraIncomeType')),
    itrFiled: dash(field(data, 'itrFiled', 'itr_filed')),
    itrYear: dash(field(data, 'itrYear', 'itr_year', 'assessmentYear')),
    cibilScore: dash(field(data, 'creditScoreRange', 'credit_score_range', 'cibilScore', 'cibil_score')),
    primaryBank: dash(field(data, 'bankName', 'bank_name', 'primaryBank', 'primary_bank')),
    accountLast4: last4(field(data, 'accountNumber', 'account_number', 'bankAccountNumber')),
    ifsc: dash(field(data, 'ifsc', 'ifsc_code', 'ifscCode')),
    avgMonthlyCredit: formatInr(field(data, 'averageMonthlyCredit', 'average_monthly_credit')),

    coApplicantName: co
      ? dash([field(co, 'firstName', 'first_name'), field(co, 'lastName', 'last_name')].filter(Boolean).join(' '))
      : '',
    coRelationship: dash(co && field(co, 'relationship')),
    coDob: formatDate(co && field(co, 'dateOfBirth', 'date_of_birth')),
    coGender: dash(co && field(co, 'gender')),
    coMarital: dash(co && field(co, 'maritalStatus', 'marital_status')),
    coPan: dash(co && (field(co, 'pan', 'pan_number') || field(co, 'panNumber'))),
    coAadhaarLast4: last4(co && (field(co, 'aadhaar', 'aadhaar_number') || field(co, 'aadhaarNumber'))),
    coMobile: dash(co && field(co, 'phone')),
    coEmail: dash(co && field(co, 'email')),
    coAddress: co ? addressLine(co) : '',
    coCity: dash(co && field(co, 'city')),
    coDistrict: dash(co && field(co, 'district')),
    coState: dash(co && field(co, 'state')),
    coPin: dash(co && field(co, 'pinCode', 'pin_code')),
    coOccupation: dash(co && field(co, 'employmentType', 'employment_type')),
    coEmployer: dash(co && field(co, 'employerName', 'employer_name')),
    coDesignation: dash(co && field(co, 'jobTitle', 'job_title')),
    coIndustry: dash(co && field(co, 'industry')),
    coYearsEmployed: dash(co && field(co, 'yearsEmployed', 'years_employed')),
    coGrossMonthly: formatInr(co && field(co, 'monthlyIncome', 'monthly_income')),
    coNetMonthly: formatInr(co && field(co, 'monthlyIncome', 'monthly_income')),

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
      emi: formatInr(loan.emi_amount || loan.emiAmount || loan.emi),
      tenureLeft: dash(loan.tenure_left || loan.tenureLeft),
      security: dash(loan.security || loan.collateral),
    })),

    propertyType: dash(field(data, 'propertyType', 'property_type')),
    ownershipStatus: dash(field(data, 'ownershipStatus', 'ownership_status')),
    ownerNames: dash(field(data, 'propertyOwnerName', 'property_owner_name') || fullName(data, row)),
    propertyAddress: dash(field(data, 'propertyAddress', 'property_address')),
    propertyCity: dash(field(data, 'propertyCity', 'property_city') || field(data, 'city')),
    propertyState: dash(field(data, 'propertyState', 'property_state') || field(data, 'state')),
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
      other: (documents || []).length > 0,
    },

    consentProcessing: (consents?.length || field(data, 'agreeTerms', 'agree_terms')) ? 'Yes' : '',
    consentPhone: yesNo(field(data, 'consentWhatsapp', 'consent_whatsapp') || true),
    consentSmsEmail: yesNo(field(data, 'consentEmail', 'consent_email') || true),
    consentFuture: yesNo(field(data, 'consentMarketing', 'consent_marketing')),

    certifyAccuracy: yesNo(field(data, 'certifyAccuracy', 'certify_accuracy') || true),
    authorizeCredit: yesNo(field(data, 'authorizeCredit', 'authorize_credit') || true),
    agreeTerms: yesNo(field(data, 'agreeTerms', 'agree_terms') || true),
    signatureName: dash(field(data, 'signatureName', 'signature_name') || fullName(data, row)),
    signatureDate: formatDate(field(data, 'signatureSignedAt', 'signature_signed_at') || submittedAt),
    signaturePlace: dash(field(data, 'city')),
    status: dash(row?.status),
    recommendedLender: dash(field(data, 'preferredBankName', 'preferred_bank_name')),
    eligibilityAmount: formatInr(field(data, 'eligibleAmount', 'eligible_amount')),
  };
}

function clip(text, maxLen = 48) {
  const s = String(text || '').trim();
  if (!s) return '';
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

function drawValue(page, font, text, x, y, size = 8, maxWidth = 220) {
  const value = clip(text, 80);
  if (!value) return;
  let draw = value;
  while (font.widthOfTextAtSize(draw, size) > maxWidth && draw.length > 3) {
    draw = `${draw.slice(0, -2)}…`;
  }
  // White strip behind value so underscore lines do not clash with text.
  const w = Math.min(maxWidth, font.widthOfTextAtSize(draw, size) + 4);
  page.drawRectangle({
    x: x - 1,
    y: y - 1.5,
    width: w,
    height: size + 3,
    color: rgb(1, 1, 1),
  });
  page.drawText(draw, {
    x,
    y,
    size,
    font,
    color: rgb(0.05, 0.15, 0.35),
  });
}

function markCheck(page, font, checked, x, y) {
  page.drawText(checked ? 'X' : '', {
    x,
    y,
    size: 9,
    font,
    color: rgb(0.05, 0.35, 0.2),
  });
}

/**
 * Fill the official blank Rfincare Bank Loan Application Form (attached template).
 * Values are stamped onto the blank 9-page PDF so the download matches the client format.
 */
export async function buildBankLoanApplicationFormPdf(payload) {
  const values = buildBankLoanApplicationValues(payload);
  const templatePath = resolveBlankTemplatePath();
  if (!templatePath) {
    throw new Error(
      'Official bank loan application form template is missing (assets/forms/Rfincare_Bank_Loan_Application_Form.pdf).',
    );
  }

  const blankBytes = readFileSync(templatePath);
  const src = await PDFDocument.load(blankBytes);
  const doc = await PDFDocument.create();
  const copied = await doc.copyPages(src, src.getPageIndices());
  copied.forEach((p) => doc.addPage(p));
  const pages = doc.getPages();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const L = 48; // left value column (after label)
  const R = 330; // right value column
  const W = 230;

  // ——— Page 1: Identification + Applicant personal ———
  {
    const p = pages[0];
    // Section 1
    drawValue(p, font, values.applicationNumber, L + 130, 628, 8, 140);
    drawValue(p, font, values.applicationDate, R + 90, 628, 8, 140);
    drawValue(p, font, values.agentCode, L + 100, 606, 8, 150);
    drawValue(p, font, values.preferredBranch, R + 130, 606, 8, 140);
    drawValue(p, font, values.loanProduct, L + 80, 584, 8, 160);
    drawValue(p, font, values.purposeOfLoan, R + 90, 584, 8, 140);
    drawValue(p, font, values.requestedAmount, L + 140, 562, 8, 120);
    drawValue(p, font, values.preferredTenure, R + 100, 562, 8, 140);
    drawValue(p, font, values.preferredLender, L + 140, 528, 8, W);
    drawValue(p, font, values.existingCustomer, L + 140, 494, 8, 160);

    // Section 2
    drawValue(p, font, values.applicantName, L + 140, 430, 8, 150);
    drawValue(p, font, values.fatherSpouseName, R + 140, 430, 8, 130);
    drawValue(p, font, values.dateOfBirth, L + 90, 408, 8, 140);
    drawValue(p, font, values.gender, R + 50, 408, 8, 140);
    drawValue(p, font, values.maritalStatus, L + 90, 386, 8, 140);
    drawValue(p, font, values.dependents, R + 130, 386, 8, 120);
    drawValue(p, font, values.nationality, L + 70, 364, 8, 150);
    drawValue(p, font, values.residentialStatus, R + 110, 364, 8, 130);
    drawValue(p, font, values.pan, L + 40, 342, 8, 160);
    drawValue(p, font, values.aadhaarLast4, L + 180, 308, 8, 160);
  }

  // ——— Page 2: Contact + Employment ———
  {
    const p = pages[1];
    drawValue(p, font, values.mobile, L + 90, 700, 8, 150);
    drawValue(p, font, values.altMobile, R + 130, 700, 8, 130);
    drawValue(p, font, values.email, L + 60, 678, 8, 180);
    drawValue(p, font, values.currentAddress, R + 100, 678, 8, 160);
    drawValue(p, font, `${values.city}${values.district ? ` / ${values.district}` : ''}`, L + 90, 656, 8, 150);
    drawValue(p, font, values.state, R + 50, 656, 8, 150);
    drawValue(p, font, values.pinCode, L + 70, 634, 8, 140);
    drawValue(p, font, values.yearsAtAddress, R + 140, 634, 8, 120);
    drawValue(p, font, values.permanentAddress, L + 110, 612, 8, 180);
    drawValue(p, font, values.residenceType, R + 130, 612, 8, 130);

    drawValue(p, font, values.occupationType, L + 200, 560, 8, 180);
    drawValue(p, font, values.employerName, L + 140, 516, 8, W);
    drawValue(p, font, values.designation, L + 160, 472, 8, W);
    drawValue(p, font, values.industry, L + 100, 450, 8, W);
    drawValue(p, font, values.officeAddress, L + 140, 428, 8, 180);
    drawValue(p, font, values.yearsEmployed, R + 180, 428, 8, 120);
    drawValue(p, font, values.totalExperience, L + 130, 384, 8, 150);
    drawValue(p, font, values.businessConstitution, R + 160, 384, 8, 130);
    drawValue(p, font, values.officialContact, L + 130, 362, 8, 150);
    drawValue(p, font, values.registrationNo, R + 180, 362, 8, 130);
  }

  // ——— Page 3: Income + Co-applicant personal ———
  {
    const p = pages[2];
    // Income table columns roughly: item | monthly | annual
    drawValue(p, font, values.grossMonthly, 220, 678, 8, 70);
    drawValue(p, font, values.grossAnnual, 310, 678, 8, 80);
    drawValue(p, font, values.netMonthly, 220, 656, 8, 70);
    drawValue(p, font, values.netAnnual, 310, 656, 8, 80);
    drawValue(p, font, values.otherIncomeMonthly, 220, 634, 8, 70);
    drawValue(p, font, values.householdExpenses, 220, 612, 8, 70);
    drawValue(p, font, values.existingEmi, 220, 590, 8, 70);
    drawValue(p, font, values.creditCardDues, 220, 568, 8, 70);

    drawValue(p, font, values.otherIncomeSource, L + 130, 534, 8, 150);
    drawValue(p, font, values.itrFiled, R + 140, 534, 8, 120);
    drawValue(p, font, values.itrYear, L + 130, 512, 8, 140);
    drawValue(p, font, values.cibilScore, R + 160, 512, 8, 120);
    drawValue(p, font, values.primaryBank, L + 130, 490, 8, 150);
    drawValue(p, font, values.accountLast4, R + 180, 490, 8, 100);
    drawValue(p, font, values.ifsc, L + 40, 468, 8, 160);
    drawValue(p, font, values.avgMonthlyCredit, R + 160, 468, 8, 120);

    // Co-applicant section 6
    drawValue(p, font, values.coApplicantName, L + 140, 390, 8, 150);
    drawValue(p, font, values.coRelationship, R + 140, 390, 8, 120);
    drawValue(p, font, values.coDob, R + 90, 368, 8, 130);
    drawValue(p, font, values.coGender, L + 50, 346, 8, 140);
    drawValue(p, font, values.coMarital, R + 90, 346, 8, 130);
    drawValue(p, font, values.coPan, R + 40, 302, 8, 140);
    drawValue(p, font, values.coAadhaarLast4, L + 180, 268, 8, 140);
  }

  // ——— Page 4: Co-applicant contact/employment + Loan requirement ———
  {
    const p = pages[3];
    drawValue(p, font, values.coCity, L + 90, 700, 8, 150);
    drawValue(p, font, values.coState, R + 50, 700, 8, 150);
    drawValue(p, font, values.coPin, L + 70, 678, 8, 140);
    drawValue(p, font, values.coAddress, L + 110, 656, 8, 180);
    drawValue(p, font, values.coMobile, L + 90, 748, 8, 140);
    drawValue(p, font, values.coEmail, L + 60, 726, 8, 180);

    drawValue(p, font, values.coOccupation, L + 100, 600, 8, 160);
    drawValue(p, font, values.coEmployer, R + 140, 600, 8, 140);
    drawValue(p, font, values.coDesignation, L + 160, 556, 8, W);
    drawValue(p, font, values.coIndustry, L + 100, 534, 8, W);
    drawValue(p, font, values.coYearsEmployed, R + 180, 512, 8, 120);
    drawValue(p, font, values.coGrossMonthly, L + 130, 468, 8, 140);
    drawValue(p, font, values.coNetMonthly, R + 160, 468, 8, 120);

    drawValue(p, font, values.endUse, L + 130, 390, 8, 150);
    drawValue(p, font, values.requestedAmount, R + 140, 390, 8, 120);
    drawValue(p, font, values.downPayment, L + 180, 356, 8, 140);
    drawValue(p, font, values.preferredTenure, L + 100, 334, 8, 160);
    drawValue(p, font, values.preferredEmi, L + 120, 312, 8, 150);
    drawValue(p, font, values.repaymentBank, R + 140, 312, 8, 130);
    drawValue(p, font, values.repaymentFrequency, L + 120, 290, 8, 150);
    drawValue(p, font, values.repaymentSource, R + 150, 290, 8, 130);
    drawValue(p, font, values.collateral, L + 140, 268, 8, 150);
    drawValue(p, font, values.assetValue, R + 150, 268, 8, 120);
  }

  // ——— Page 5: Existing loans + Banking + Property ———
  {
    const p = pages[4];
    const loanRowsY = [660, 638, 616, 594];
    values.loans.forEach((loan, idx) => {
      const y = loanRowsY[idx];
      if (!y) return;
      drawValue(p, font, loan.lender, 48, y, 7, 80);
      drawValue(p, font, loan.type, 140, y, 7, 70);
      drawValue(p, font, loan.last4, 220, y, 7, 40);
      drawValue(p, font, loan.original, 270, y, 7, 55);
      drawValue(p, font, loan.outstanding, 340, y, 7, 55);
      drawValue(p, font, loan.emi, 410, y, 7, 45);
      drawValue(p, font, loan.tenureLeft, 465, y, 7, 45);
      drawValue(p, font, loan.security, 520, y, 7, 55);
    });

    drawValue(p, font, values.primaryBank, 48, 500, 8, 90);
    drawValue(p, font, 'Savings', 150, 500, 8, 60);
    drawValue(p, font, values.accountLast4, 230, 500, 8, 40);
    drawValue(p, font, values.avgMonthlyCredit, 290, 500, 8, 60);
    drawValue(p, font, values.existingEmi, 370, 500, 8, 55);

    drawValue(p, font, values.propertyType, L + 120, 390, 8, 150);
    drawValue(p, font, values.ownershipStatus, R + 110, 390, 8, 130);
    drawValue(p, font, values.ownerNames, L + 100, 368, 8, 160);
    drawValue(p, font, values.propertyAddress, R + 110, 368, 8, 140);
    drawValue(p, font, values.propertyCity, L + 90, 346, 8, 150);
    drawValue(p, font, values.propertyState, R + 50, 346, 8, 150);
    drawValue(p, font, values.propertyPin, L + 70, 324, 8, 140);
    drawValue(p, font, values.marketValue, R + 150, 324, 8, 120);
    drawValue(p, font, values.purchaseCost, L + 180, 290, 8, 140);
    drawValue(p, font, values.existingCharge, R + 140, 290, 8, 120);
  }

  // ——— Page 6: Document checklist ———
  {
    const p = pages[5];
    const rows = [
      { y: 620, ok: values.docs.pan },
      { y: 598, ok: values.docs.idProof },
      { y: 576, ok: values.docs.photo },
      { y: 554, ok: values.docs.bank },
      { y: 532, ok: values.docs.salary },
      { y: 510, ok: values.docs.itr },
      { y: 488, ok: values.docs.employment },
      { y: 466, ok: values.docs.property },
      { y: 430, ok: values.docs.loanStmt },
      { y: 396, ok: values.docs.other },
    ];
    rows.forEach((row) => {
      markCheck(p, fontBold, row.ok, 292, row.y);
      if (row.ok) drawValue(p, font, 'Uploaded', 360, row.y, 7, 120);
    });
  }

  // ——— Page 7: Declarations + consent ———
  {
    const p = pages[6];
    // Consent Yes column ~ x 292
    if (values.consentProcessing === 'Yes') markCheck(p, fontBold, true, 292, 268);
    if (values.consentPhone === 'Yes') markCheck(p, fontBold, true, 292, 246);
    if (values.consentSmsEmail === 'Yes') markCheck(p, fontBold, true, 292, 224);
    if (values.consentFuture === 'Yes') markCheck(p, fontBold, true, 292, 190);
  }

  // ——— Page 8: Office use + acknowledgement ———
  {
    const p = pages[7];
    drawValue(p, font, values.recommendedLender, L + 140, 700, 8, 150);
    drawValue(p, font, values.loanProduct, R + 120, 700, 8, 140);
    drawValue(p, font, values.eligibilityAmount, L + 160, 666, 8, 140);
    drawValue(p, font, values.requestedAmount, R + 150, 666, 8, 120);
    drawValue(p, font, values.status, L + 140, 610, 8, 160);
    drawValue(p, font, values.applicationNumber, R + 160, 588, 8, 120);

    drawValue(p, font, values.signatureName, L + 40, 330, 8, 180);
    drawValue(p, font, values.coApplicantName, R + 20, 330, 8, 180);
    drawValue(p, font, values.signatureDate, L + 40, 286, 8, 160);
    drawValue(p, font, values.signaturePlace, R + 40, 286, 8, 160);
    drawValue(p, font, values.applicantName, L + 120, 264, 8, 160);
    drawValue(p, font, values.coApplicantName, R + 140, 264, 8, 140);
  }

  // Page 9 is disclaimer-only — leave as-is (matches attached blank format).

  // Small system stamp on page 1 so staff know it is system-filled.
  pages[0].drawText('SYSTEM-FILLED FROM APPLICATION DATA', {
    x: 360,
    y: 760,
    size: 7,
    font: fontBold,
    color: rgb(0.0, 0.45, 0.35),
  });

  return Buffer.from(await doc.save());
}

export function getBlankBankLoanApplicationFormPath() {
  return resolveBlankTemplatePath();
}
