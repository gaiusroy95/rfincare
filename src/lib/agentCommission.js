import { newId } from './ids.js';
import { escapeCsvCell } from './parseCsv.js';
import {
  buildConfigCircularId,
  normalizeLearningPublicUrl,
  resolveLearningDiskPath,
} from './learningFileDelivery.js';

const LOAN_TYPE_ALIASES = {
  personal: 'personal_loan',
  home: 'home_loan',
  business: 'business_loan',
  auto: 'auto_loan',
  education: 'education_loan',
  personal_loan: 'personal_loan',
  home_loan: 'home_loan',
  business_loan: 'business_loan',
  auto_loan: 'auto_loan',
  education_loan: 'education_loan',
};

export const AGENT_COMMISSION_CSV_HEADERS = [
  'agent_name',
  'agent_code',
  'mobile_number',
  'account_status',
  'bank_details',
  'account_number',
  'bank_name',
  'ifsc_code',
  'loan_type',
  'commission_type',
  'commission_value',
  'min_loan_amount',
  'max_loan_amount',
  'effective_from',
  'effective_to',
  'circular_title',
  'upload',
];

const HEADER_ALIASES = {
  agent_name: ['agent_name', 'name', 'agent'],
  agent_code: ['agent_code', 'code', 'agent_id', 'id'],
  mobile_number: ['mobile_number', 'mobile', 'phone', 'phone_number'],
  account_status: ['account_status', 'status'],
  bank_details: ['bank_details', 'bank_detail', 'bank'],
  account_number: ['account_number', 'account_no', 'acct'],
  bank_name: ['bank_name'],
  ifsc_code: ['ifsc_code', 'ifsc'],
  loan_type: ['loan_type', 'product', 'loan'],
  commission_type: ['commission_type', 'comm_type'],
  commission_value: [
    'commission_value',
    'commission_value_pct',
    'commission_pct',
    'commission_percent',
    'commission_rate',
  ],
  min_loan_amount: ['min_loan_amount', 'minimum_loan_value', 'min_loan'],
  max_loan_amount: ['max_loan_amount', 'maximum_loan_value', 'max_loan'],
  effective_from: ['effective_from', 'valid_from', 'start_date'],
  effective_to: ['effective_to', 'valid_to', 'end_date'],
  circular_title: ['circular_title', 'circular', 'circular_name'],
  upload: ['upload', 'upload_column', 'circular_file', 'circular_url', 'file', 'pdf'],
};

function pickField(row, canonical) {
  const keys = HEADER_ALIASES[canonical] || [canonical];
  for (const key of keys) {
    if (row[key] != null && String(row[key]).trim() !== '') {
      return String(row[key]).trim();
    }
  }
  return '';
}

export function normalizeCommissionCsvRow(raw) {
  const agentCode = pickField(raw, 'agent_code');
  if (!agentCode) {
    const err = new Error('agent_code is required');
    err.status = 400;
    throw err;
  }

  let accountNumber = pickField(raw, 'account_number');
  let bankName = pickField(raw, 'bank_name');
  let ifscCode = pickField(raw, 'ifsc_code');
  const bankDetails = pickField(raw, 'bank_details');
  if (bankDetails && (!accountNumber || !bankName || !ifscCode)) {
    const parts = bankDetails.split(/[|;]/).map((p) => p.trim());
    if (parts.length >= 3) {
      accountNumber = accountNumber || parts[0];
      bankName = bankName || parts[1];
      ifscCode = ifscCode || parts[2];
    }
  }

  const loanRaw = pickField(raw, 'loan_type') || 'home_loan';
  const loanKey = loanRaw.toLowerCase().replace(/\s+/g, '_');
  const loanType = LOAN_TYPE_ALIASES[loanKey] || (loanKey.endsWith('_loan') ? loanKey : 'home_loan');

  let commissionType = (pickField(raw, 'commission_type') || 'percentage').toLowerCase();
  if (commissionType === '%' || commissionType === 'percent') commissionType = 'percentage';
  if (!['percentage', 'fixed'].includes(commissionType)) commissionType = 'percentage';

  const commissionValue = Number(pickField(raw, 'commission_value') || 0);
  if (!Number.isFinite(commissionValue) || commissionValue < 0) {
    const err = new Error('commission_value must be a non-negative number');
    err.status = 400;
    throw err;
  }

  const parseMoney = (v) => {
    if (!v) return null;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  const parseDate = (v) => {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  };

  return {
    agentName: pickField(raw, 'agent_name'),
    agentCode,
    mobileNumber: pickField(raw, 'mobile_number'),
    accountStatus: pickField(raw, 'account_status'),
    accountNumber: accountNumber || null,
    bankName: bankName || null,
    ifscCode: ifscCode || null,
    loanType,
    commissionType,
    commissionValue,
    minLoanAmount: parseMoney(pickField(raw, 'min_loan_amount')),
    maxLoanAmount: parseMoney(pickField(raw, 'max_loan_amount')),
    effectiveFrom: parseDate(pickField(raw, 'effective_from')),
    effectiveTo: parseDate(pickField(raw, 'effective_to')),
    circularTitle: pickField(raw, 'circular_title'),
    upload: pickField(raw, 'upload'),
  };
}

export function mapCommissionConfigRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentUserId: row.agent_user_id,
    agentCode: row.agent_code,
    agentName: row.agent_name,
    loanType: row.loan_type,
    commissionType: row.commission_type,
    commissionValue: Number(row.commission_value),
    minLoanAmount: row.min_loan_amount,
    maxLoanAmount: row.max_loan_amount,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    circularTitle: row.circular_title,
    circularFileUrl: row.circular_file_url,
    updatedAt: row.updated_at,
  };
}

export async function resolveAgentCommissionConfig(pool, agentUserId, loanType = null) {
  if (loanType) {
    const [[row]] = await pool.execute(
      `SELECT * FROM agent_commission_config
       WHERE agent_user_id = :uid AND loan_type = :lt
       LIMIT 1`,
      { uid: agentUserId, lt: loanType },
    );
    if (row) return row;
  }

  const [[latest]] = await pool.execute(
    `SELECT * FROM agent_commission_config
     WHERE agent_user_id = :uid
     ORDER BY updated_at DESC
     LIMIT 1`,
    { uid: agentUserId },
  );
  if (latest) return latest;

  const [[globalRow]] = await pool.execute(
    `SELECT * FROM global_commission_config WHERE id = 'default' LIMIT 1`,
  );
  return globalRow || null;
}

async function findAgentByCode(pool, agentCode) {
  const [[row]] = await pool.execute(
    `SELECT up.id AS user_id, up.full_name, up.account_status, up.phone,
            ao.id AS onboarding_id, ao.agent_name, ao.agent_code, ao.mobile_number,
            ao.account_number, ao.bank_name, ao.ifsc_code, ao.onboarding_status
     FROM agent_onboarding ao
     INNER JOIN user_profiles up ON up.id = ao.user_id
     WHERE ao.agent_code = :code AND up.role = 'agent'
     LIMIT 1`,
    { code: agentCode },
  );
  return row || null;
}

async function updateAgentProfileFromRow(pool, agent, row, updatedBy) {
  if (row.agentName) {
    await pool.execute(
      `UPDATE user_profiles SET full_name = :name WHERE id = :id`,
      { name: row.agentName, id: agent.user_id },
    );
    await pool.execute(
      `UPDATE agent_onboarding SET agent_name = :name WHERE user_id = :id`,
      { name: row.agentName, id: agent.user_id },
    );
  }

  if (row.mobileNumber) {
    await pool.execute(`UPDATE user_profiles SET phone = :phone WHERE id = :id`, {
      phone: row.mobileNumber,
      id: agent.user_id,
    });
    await pool.execute(`UPDATE agent_onboarding SET mobile_number = :phone WHERE user_id = :id`, {
      phone: row.mobileNumber,
      id: agent.user_id,
    });
  }

  if (row.accountStatus) {
    const status = row.accountStatus.toLowerCase();
    await pool.execute(
      `UPDATE user_profiles SET account_status = :st WHERE id = :id`,
      { st: status, id: agent.user_id },
    );
    await pool.execute(
      `UPDATE agent_onboarding SET onboarding_status = :st WHERE user_id = :id`,
      { st: status, id: agent.user_id },
    );
  }

  if (row.accountNumber || row.bankName || row.ifscCode) {
    await pool.execute(
      `UPDATE agent_onboarding
       SET account_number = COALESCE(:acct, account_number),
           bank_name = COALESCE(:bank, bank_name),
           ifsc_code = COALESCE(:ifsc, ifsc_code)
       WHERE user_id = :id`,
      {
        acct: row.accountNumber,
        bank: row.bankName,
        ifsc: row.ifscCode,
        id: agent.user_id,
      },
    );
  }
}

async function resolveCircularFileUrl(pool, row, circularFilesByName) {
  const uploadVal = row.upload;
  if (uploadVal) {
    const matched =
      circularFilesByName[uploadVal] ||
      circularFilesByName[uploadVal.toLowerCase()] ||
      circularFilesByName[uploadVal.split(/[/\\]/).pop()] ||
      circularFilesByName[uploadVal.split(/[/\\]/).pop()?.toLowerCase()];
    if (matched?.storedUrl) return matched.storedUrl;
    if (/^https?:\/\//i.test(uploadVal) || uploadVal.startsWith('/uploads/')) {
      return uploadVal;
    }
    const diskPath = resolveLearningDiskPath({ fileUrl: uploadVal, fileName: uploadVal.split(/[/\\]/).pop() });
    if (diskPath) return normalizeLearningPublicUrl(uploadVal);
  }

  if (row.circularTitle) {
    const [[existing]] = await pool.execute(
      `SELECT file_url FROM agent_commission_circulars
       WHERE title = :title AND is_active = 1
       ORDER BY created_at DESC LIMIT 1`,
      { title: row.circularTitle },
    );
    if (existing?.file_url) {
      return normalizeLearningPublicUrl(existing.file_url) || existing.file_url;
    }
  }

  return null;
}

function resolveCircularUploadMeta(row, circularFilesByName) {
  const uploadVal = row.upload;
  if (!uploadVal) return null;
  return (
    circularFilesByName[uploadVal] ||
    circularFilesByName[uploadVal.toLowerCase()] ||
    circularFilesByName[uploadVal.split(/[/\\]/).pop()] ||
    circularFilesByName[uploadVal.split(/[/\\]/).pop()?.toLowerCase()] ||
    null
  );
}

export async function ensureCommissionCircularRecord(
  pool,
  { title, fileUrl, fileName, filePath, uploadedBy },
) {
  if (!fileUrl) return null;

  const circularTitle = (title || fileName || 'Commission circular').trim();
  const safeFileName = fileName || `${circularTitle}.pdf`;

  const [[existingByUrl]] = await pool.execute(
    `SELECT id FROM agent_commission_circulars
     WHERE file_url = :url AND is_active = 1
     LIMIT 1`,
    { url: fileUrl },
  );
  if (existingByUrl?.id) return existingByUrl.id;

  const [[existingByTitle]] = await pool.execute(
    `SELECT id FROM agent_commission_circulars
     WHERE title = :title AND is_active = 1
     LIMIT 1`,
    { title: circularTitle },
  );
  if (existingByTitle?.id) {
    await pool.execute(
      `UPDATE agent_commission_circulars
       SET file_name = :file_name, file_path = :file_path, file_url = :file_url, uploaded_by = :uploaded_by
       WHERE id = :id`,
      {
        id: existingByTitle.id,
        file_name: safeFileName,
        file_path: filePath || fileUrl,
        file_url: fileUrl,
        uploaded_by: uploadedBy || null,
      },
    );
    return existingByTitle.id;
  }

  const id = newId();
  await pool.execute(
    `INSERT INTO agent_commission_circulars
     (id, title, description, file_name, file_path, file_url, uploaded_by)
     VALUES (:id, :title, NULL, :file_name, :file_path, :file_url, :uploaded_by)`,
    {
      id,
      title: circularTitle,
      file_name: safeFileName,
      file_path: filePath || fileUrl,
      file_url: fileUrl,
      uploaded_by: uploadedBy || null,
    },
  );
  return id;
}

/** Circulars for agent dashboard — table rows plus legacy config-only uploads. */
export async function fetchAgentCommissionCirculars(pool) {
  const [rows] = await pool.execute(
    `SELECT id, title, description, file_name, file_url, created_at
     FROM agent_commission_circulars
     WHERE is_active = 1
     ORDER BY created_at DESC`,
  );

  const seenUrls = new Set((rows || []).map((row) => row.file_url).filter(Boolean));
  const circulars = [...(rows || [])];

  const [configRows] = await pool.execute(
    `SELECT DISTINCT circular_title, circular_file_url, updated_at
     FROM agent_commission_config
     WHERE circular_file_url IS NOT NULL AND TRIM(circular_file_url) != ''
     ORDER BY updated_at DESC`,
  );

  for (const cfg of configRows || []) {
    const fileUrl = normalizeLearningPublicUrl(cfg.circular_file_url) || cfg.circular_file_url;
    if (!fileUrl || seenUrls.has(fileUrl)) continue;
    seenUrls.add(fileUrl);
    circulars.push({
      id: buildConfigCircularId(cfg.circular_file_url),
      title: cfg.circular_title || 'Commission circular',
      description: null,
      file_name: cfg.circular_title || 'circular.pdf',
      file_url: fileUrl,
      file_path: fileUrl,
      created_at: cfg.updated_at,
    });
  }

  circulars.sort(
    (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime(),
  );

  return circulars.map((row) => ({
    ...row,
    file_url: normalizeLearningPublicUrl(row.file_url) || row.file_url,
  }));
}

export async function upsertAgentCommissionConfig(pool, agentUserId, row, { updatedBy, circularFilesByName = {} }) {
  const circularFileUrl = await resolveCircularFileUrl(pool, row, circularFilesByName);
  const uploadMeta = resolveCircularUploadMeta(row, circularFilesByName);

  if (circularFileUrl) {
    await ensureCommissionCircularRecord(pool, {
      title: row.circularTitle || uploadMeta?.originalName || row.upload || 'Commission circular',
      fileUrl: circularFileUrl,
      fileName: uploadMeta?.filename || row.upload || 'circular.pdf',
      filePath: uploadMeta?.filePath || circularFileUrl,
      uploadedBy: updatedBy,
    });
  }

  const [[existing]] = await pool.execute(
    `SELECT id FROM agent_commission_config
     WHERE agent_user_id = :uid AND loan_type = :lt LIMIT 1`,
    { uid: agentUserId, lt: row.loanType },
  );

  const payload = {
    agent_user_id: agentUserId,
    agent_code: row.agentCode,
    agent_name: row.agentName || null,
    loan_type: row.loanType,
    commission_type: row.commissionType,
    commission_value: row.commissionValue,
    min_loan_amount: row.minLoanAmount,
    max_loan_amount: row.maxLoanAmount,
    effective_from: row.effectiveFrom,
    effective_to: row.effectiveTo,
    circular_title: row.circularTitle || null,
    circular_file_url: circularFileUrl,
    updated_by: updatedBy,
  };

  if (existing?.id) {
    await pool.execute(
      `UPDATE agent_commission_config
       SET agent_code = :agent_code,
           agent_name = :agent_name,
           commission_type = :commission_type,
           commission_value = :commission_value,
           min_loan_amount = :min_loan_amount,
           max_loan_amount = :max_loan_amount,
           effective_from = :effective_from,
           effective_to = :effective_to,
           circular_title = :circular_title,
           circular_file_url = :circular_file_url,
           updated_by = :updated_by
       WHERE id = :id`,
      { ...payload, id: existing.id },
    );
    return existing.id;
  }

  const id = newId();
  await pool.execute(
    `INSERT INTO agent_commission_config (
       id, agent_user_id, agent_code, agent_name, loan_type,
       commission_type, commission_value, min_loan_amount, max_loan_amount,
       effective_from, effective_to, circular_title, circular_file_url, updated_by
     ) VALUES (
       :id, :agent_user_id, :agent_code, :agent_name, :loan_type,
       :commission_type, :commission_value, :min_loan_amount, :max_loan_amount,
       :effective_from, :effective_to, :circular_title, :circular_file_url, :updated_by
     )`,
    { id, ...payload },
  );
  return id;
}

export async function importAgentCommissionRows(pool, rawRows, { updatedBy, circularFilesByName = {} }) {
  const results = [];
  let imported = 0;
  let failed = 0;

  for (let i = 0; i < rawRows.length; i += 1) {
    const lineNo = i + 2;
    try {
      const row = normalizeCommissionCsvRow(rawRows[i]);
      const agent = await findAgentByCode(pool, row.agentCode);
      if (!agent) {
        throw new Error(`No agent found for code "${row.agentCode}"`);
      }

      await updateAgentProfileFromRow(pool, agent, row, updatedBy);
      const configId = await upsertAgentCommissionConfig(pool, agent.user_id, row, {
        updatedBy,
        circularFilesByName,
      });

      imported += 1;
      results.push({
        line: lineNo,
        status: 'imported',
        agentCode: row.agentCode,
        configId,
      });
    } catch (err) {
      failed += 1;
      results.push({
        line: lineNo,
        status: 'failed',
        error: err.message || 'Import failed',
      });
    }
  }

  return { imported, failed, total: rawRows.length, results };
}

export function buildAgentCommissionTemplateCsv() {
  const sample = [
    'Sample Agent',
    'RFA20261',
    '9876543210',
    'active',
    '1234567890|HDFC Bank|HDFC0001234',
    '',
    '',
    '',
    'home_loan',
    'percentage',
    '2.5',
    '100000',
    '5000000',
    '2026-01-01',
    '2026-12-31',
    'Commission Policy Q1 2026',
    'policy-q1.pdf',
  ];
  return `${AGENT_COMMISSION_CSV_HEADERS.join(',')}\n${sample.map(escapeCsvCell).join(',')}\n`;
}
