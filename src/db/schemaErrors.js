/** Duplicate column errors when running idempotent ALTER TABLE bootstraps. */
export function isDuplicateColumnError(err) {
  return err?.code === 'ER_DUP_FIELDNAME' || err?.code === '42701';
}

/** Migration already applied (table/column/index exists). */
export function isIgnorableMigrationError(err) {
  const code = err?.code;
  return (
    code === 'ER_DUP_FIELDNAME'
    || code === 'ER_TABLE_EXISTS_ERROR'
    || code === '42P07' // duplicate_table
    || code === '42701' // duplicate_column
    || code === '42710' // duplicate_object
    || code === '23505' // unique_violation on seed re-run
  );
}
