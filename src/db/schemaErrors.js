/** Duplicate column errors when running idempotent ALTER TABLE bootstraps. */
export function isDuplicateColumnError(err) {
  return err?.code === '42701';
}

/** Migration already applied (table/column/index exists). */
export function isIgnorableMigrationError(err) {
  return (
    err?.code === '42701'
    || err?.code === '42710'
    || err?.code === '42P07'
    || err?.code === '23505'
  );
}

export function isDuplicateEntryError(err) {
  return err?.code === '23505';
}

export function isNoSuchTableError(err) {
  return err?.code === '42P01';
}

export function isBadFieldError(err) {
  return err?.code === '42703';
}

export function isTableExistsError(err) {
  return err?.code === '42P07';
}

export function isIgnorableEnsureError(err) {
  return (
    isDuplicateColumnError(err)
    || isIgnorableMigrationError(err)
    || isDuplicateEntryError(err)
    || isTableExistsError(err)
    || isNoSuchTableError(err)
    || isBadFieldError(err)
  );
}
