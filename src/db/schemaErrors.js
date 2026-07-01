/** Duplicate column errors when running idempotent ALTER TABLE bootstraps. */
export function isDuplicateColumnError(err) {
  const code = normalizeDbErrorCode(err);
  return code === 'ER_DUP_FIELDNAME' || code === '42701';
}

/** Migration already applied (table/column/index exists). */
export function isIgnorableMigrationError(err) {
  const code = normalizeDbErrorCode(err);
  return (
    code === 'ER_DUP_FIELDNAME'
    || code === 'ER_TABLE_EXISTS_ERROR'
    || code === '42P07'
    || code === '42701'
    || code === '42710'
    || code === '23505'
  );
}

export function isDuplicateEntryError(err) {
  const code = normalizeDbErrorCode(err);
  return code === 'ER_DUP_ENTRY' || code === '23505';
}

export function isNoSuchTableError(err) {
  const code = normalizeDbErrorCode(err);
  return code === 'ER_NO_SUCH_TABLE' || code === '42P01';
}

export function isBadFieldError(err) {
  const code = normalizeDbErrorCode(err);
  return code === 'ER_BAD_FIELD_ERROR' || code === '42703';
}

export function isTableExistsError(err) {
  const code = normalizeDbErrorCode(err);
  return code === 'ER_TABLE_EXISTS_ERROR' || code === '42P07';
}

/** Map PostgreSQL error codes to familiar MySQL codes used in catch blocks. */
export function normalizeDbErrorCode(err) {
  if (!err) return null;
  if (err.code?.startsWith?.('ER_')) return err.code;

  switch (err.code) {
    case '23505':
      return 'ER_DUP_ENTRY';
    case '42P01':
      return 'ER_NO_SUCH_TABLE';
    case '42703':
      return 'ER_BAD_FIELD_ERROR';
    case '42P07':
      return 'ER_TABLE_EXISTS_ERROR';
    case '42701':
      return 'ER_DUP_FIELDNAME';
    default:
      return err.code;
  }
}

export function normalizeDbError(err) {
  if (!err || err.code?.startsWith?.('ER_')) return err;
  const mapped = normalizeDbErrorCode(err);
  if (mapped && mapped !== err.code) {
    err.code = mapped;
  }
  return err;
}
