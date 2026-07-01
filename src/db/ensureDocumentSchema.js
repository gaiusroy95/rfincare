import { getPool, isDuplicateColumnError } from './pool.js';

let ensured = false;

export async function ensureDocumentSchema() {
  if (ensured) return;
  const pool = getPool();
  try {
    await pool.execute(
      'ALTER TABLE customer_documents ADD COLUMN verification_notes TEXT NULL AFTER verification_status',
    );
  } catch (err) {
    if (!isDuplicateColumnError(err)) throw err;
  }
  ensured = true;
}
