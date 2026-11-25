import { executeIgnoringMissing } from '../db/transaction.js';

/**
 * Hard-delete loan applications and all dependent rows.
 * Safe on older schemas: missing tables are ignored (transaction-safe via SAVEPOINT).
 */
async function deleteIfExists(pool, sql, params) {
  await executeIgnoringMissing(pool, sql, params);
}

/** Remove stored document files (disk + durable Postgres copy). Best-effort. */
export async function deleteApplicationFiles(filePaths = []) {
  const paths = [...new Set((filePaths || []).filter((p) => p && !String(p).startsWith('http')))];
  if (!paths.length) return;
  try {
    const { deleteStoredFile } = await import('./storage/index.js');
    for (const path of paths) {
      await deleteStoredFile(path).catch(() => {});
    }
  } catch {
    /* storage cleanup is best-effort */
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

  // Collect stored files; they are removed after the rows (after COMMIT for transactions).
  const filePaths = [];
  const docsResult = await executeIgnoringMissing(
    pool,
    `SELECT id, file_path FROM customer_documents WHERE application_id IN (${inClause})`,
    params,
  );
  for (const doc of docsResult?.[0] || []) {
    if (doc.file_path) filePaths.push(doc.file_path);
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

  // Outside a transaction the rows are already gone — remove the files now. Inside one,
  // the caller removes them after COMMIT (see `filePaths`).
  if (!pool?.inTransaction) await deleteApplicationFiles(filePaths);

  return { deleted: result.affectedRows ?? ids.length, filePaths };
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
