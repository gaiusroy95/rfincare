import { unlink } from 'node:fs/promises';

/**
 * Hard-delete loan applications and all dependent rows.
 * Safe on older schemas: missing tables are ignored.
 */
async function deleteIfExists(pool, sql, params) {
  try {
    await pool.execute(sql, params);
  } catch (err) {
    if (err?.code === '42P01' || err?.code === '42703') return;
    throw err;
  }
}

export async function hardDeleteApplications(pool, applicationIds) {
  const ids = [...new Set((applicationIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return { deleted: 0 };

  const params = {};
  const placeholders = ids.map((id, i) => {
    const key = `id${i}`;
    params[key] = id;
    return `:${key}`;
  });
  const inClause = placeholders.join(', ');

  // Remove uploaded files from disk when paths are local.
  try {
    const [docs] = await pool.execute(
      `SELECT id, file_path, document_url FROM customer_documents WHERE application_id IN (${inClause})`,
      params,
    );
    for (const doc of docs || []) {
      for (const path of [doc.file_path, doc.document_url]) {
        if (!path || String(path).startsWith('http')) continue;
        try {
          await unlink(path);
        } catch {
          /* file may already be gone */
        }
      }
    }
  } catch (err) {
    if (err?.code !== '42P01' && err?.code !== '42703') throw err;
  }

  await deleteIfExists(pool, `DELETE FROM customer_documents WHERE application_id IN (${inClause})`, params);
  await deleteIfExists(pool, `DELETE FROM documents WHERE application_id IN (${inClause})`, params);
  await deleteIfExists(pool, `DELETE FROM application_consents WHERE application_id IN (${inClause})`, params);
  await deleteIfExists(pool, `DELETE FROM otp_verifications WHERE application_id IN (${inClause})`, params);
  await deleteIfExists(pool, `DELETE FROM application_timeline WHERE application_id IN (${inClause})`, params);
  await deleteIfExists(pool, `DELETE FROM application_bank_share_log WHERE application_id IN (${inClause})`, params);
  await deleteIfExists(pool, `DELETE FROM staff_message_attachments WHERE message_id IN (
    SELECT id FROM staff_messages WHERE application_id IN (${inClause})
  )`, params);
  await deleteIfExists(pool, `DELETE FROM staff_messages WHERE application_id IN (${inClause})`, params);
  await deleteIfExists(pool, `DELETE FROM notifications WHERE application_id IN (${inClause})`, params);
  await deleteIfExists(
    pool,
    `UPDATE marketing_leads SET application_id = NULL WHERE application_id IN (${inClause})`,
    params,
  );
  await deleteIfExists(
    pool,
    `UPDATE application_form_drafts SET application_id = NULL WHERE application_id IN (${inClause})`,
    params,
  );
  await deleteIfExists(
    pool,
    `DELETE FROM application_form_drafts WHERE application_id IN (${inClause})`,
    params,
  );

  const [result] = await pool.execute(
    `DELETE FROM loan_applications WHERE id IN (${inClause})`,
    params,
  );

  return { deleted: result.affectedRows ?? ids.length };
}

export async function listApplicationIdsForCustomer(pool, customerId) {
  const [rows] = await pool.execute(
    `SELECT id FROM loan_applications WHERE customer_id = :id`,
    { id: customerId },
  );
  return (rows || []).map((r) => r.id);
}

export async function listApplicationIdsForAgent(pool, agentUserId, agentCode = null) {
  const [rows] = await pool.execute(
    `SELECT id FROM loan_applications
     WHERE agent_id = :id
        OR (
          :code IS NOT NULL
          AND TRIM(CAST(:code AS TEXT)) <> ''
          AND LOWER(TRIM(CAST(COALESCE(sourced_agent_code, '') AS TEXT))) = LOWER(TRIM(CAST(:code AS TEXT)))
        )`,
    { id: agentUserId, code: agentCode || null },
  );
  return (rows || []).map((r) => r.id);
}
