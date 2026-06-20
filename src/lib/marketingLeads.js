import { newId } from './ids.js';
import { ensureLeadCollation } from '../db/ensureLeadCollation.js';
import { sqlParamEquals, sqlParamEqualsLower } from './sqlCollation.js';

export function normalizeLeadEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function normalizeLeadPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

/**
 * Find the most recently updated lead for the same contact (email + phone) or session.
 */
export async function findMarketingLeadByContact(pool, { email, phone, sessionKey }) {
  await ensureLeadCollation();

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

/**
 * Create or update a marketing lead keyed by email + phone (or session).
 */
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
  await ensureLeadCollation();

  const normalizedEmail = normalizeLeadEmail(email);
  const normalizedPhone = normalizeLeadPhone(phone);
  const existing = await findMarketingLeadByContact(pool, {
    email: normalizedEmail,
    phone: normalizedPhone,
    sessionKey,
  });

  const consent = consentAccepted ? 1 : 0;

  if (existing) {
    await pool.execute(
      `UPDATE marketing_leads SET
         full_name = CASE WHEN :full_name != '' THEN :full_name ELSE full_name END,
         email = :email,
         phone = :phone,
         loan_type = COALESCE(:loan_type, loan_type),
         source = COALESCE(:source, source),
         consent_accepted = GREATEST(consent_accepted, :consent),
         session_key = COALESCE(:session_key, session_key),
         application_id = COALESCE(:application_id, application_id),
         updated_at = NOW(3)
       WHERE id = :id`,
      {
        id: existing.id,
        full_name: fullName || '',
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
       :id, :full_name, :email, :phone, :loan_type, :source, :status, :consent, :session_key, :application_id
     )`,
    {
      id,
      full_name: fullName || null,
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
