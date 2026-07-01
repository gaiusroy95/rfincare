import { newId } from './ids.js';
import { sqlCastParam, sqlParamEquals, sqlParamEqualsLower } from './sqlCollation.js';

export function normalizeLeadEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function normalizeLeadPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

export async function findMarketingLeadByContact(pool, { email, phone, sessionKey }) {
  if (sessionKey) {
    const [[row]] = await pool.execute(
      `SELECT * FROM marketing_leads WHERE ${sqlParamEquals('session_key', 'sk')} LIMIT 1`,
      { sk: sessionKey },
    );
    if (row) return row;
  }

  const normalizedEmail = normalizeLeadEmail(email);
  const normalizedPhone = normalizeLeadPhone(phone);
  if (!normalizedEmail || normalizedPhone.length !== 10) return null;

  const [rows] = await pool.execute(
    `SELECT * FROM marketing_leads
     WHERE ${sqlParamEqualsLower('email', 'email')}
     ORDER BY updated_at DESC
     LIMIT 20`,
    { email: normalizedEmail },
  );

  for (const row of rows) {
    if (normalizeLeadPhone(row.phone) === normalizedPhone) return row;
  }
  return null;
}

export async function upsertMarketingLead(
  pool,
  {
    fullName = '',
    email,
    phone,
    loanType = null,
    source = 'eligibility',
    consentAccepted = false,
    sessionKey = null,
    status = null,
    applicationId = null,
  },
) {
  const normalizedEmail = normalizeLeadEmail(email);
  const normalizedPhone = normalizeLeadPhone(phone);
  const trimmedName = String(fullName || '').trim();
  const existing = await findMarketingLeadByContact(pool, {
    email: normalizedEmail,
    phone: normalizedPhone,
    sessionKey,
  });

  const consent = Boolean(consentAccepted);

  if (existing) {
    await pool.execute(
      `UPDATE marketing_leads SET
         full_name = CASE WHEN :use_name THEN ${sqlCastParam('full_name')} ELSE full_name END,
         email = ${sqlCastParam('email')},
         phone = ${sqlCastParam('phone')},
         loan_type = CASE WHEN :loan_type IS NULL THEN loan_type ELSE ${sqlCastParam('loan_type')} END,
         source = CASE WHEN :source IS NULL THEN source ELSE ${sqlCastParam('source')} END,
         consent_accepted = consent_accepted OR :consent,
         session_key = CASE WHEN :session_key IS NULL THEN session_key ELSE ${sqlCastParam('session_key')} END,
         application_id = CASE WHEN :application_id IS NULL THEN application_id ELSE :application_id END,
         updated_at = NOW()
       WHERE id = :id`,
      {
        id: existing.id,
        use_name: Boolean(trimmedName),
        full_name: trimmedName,
        email: normalizedEmail,
        phone: normalizedPhone,
        loan_type: loanType || null,
        source: source || null,
        consent,
        session_key: sessionKey || null,
        application_id: applicationId || null,
      },
    );

    const [[row]] = await pool.execute(`SELECT * FROM marketing_leads WHERE id = :id`, {
      id: existing.id,
    });
    return { row, created: false };
  }

  const id = newId();
  await pool.execute(
    `INSERT INTO marketing_leads (
       id, full_name, email, phone, loan_type, source, status, consent_accepted, session_key, application_id
     ) VALUES (
       :id,
       CASE WHEN :use_name THEN ${sqlCastParam('full_name')} ELSE NULL END,
       ${sqlCastParam('email')},
       ${sqlCastParam('phone')},
       ${sqlCastParam('loan_type')},
       ${sqlCastParam('source')},
       ${sqlCastParam('status')},
       :consent,
       ${sqlCastParam('session_key')},
       :application_id
     )`,
    {
      id,
      use_name: Boolean(trimmedName),
      full_name: trimmedName,
      email: normalizedEmail,
      phone: normalizedPhone,
      loan_type: loanType || null,
      source: source || 'eligibility',
      status: status || 'new',
      consent,
      session_key: sessionKey || null,
      application_id: applicationId || null,
    },
  );

  const [[row]] = await pool.execute(`SELECT * FROM marketing_leads WHERE id = :id`, { id });
  return { row, created: true };
}
