import { isPostgres } from './provider.js';
import {
  isBadFieldError,
  isDuplicateColumnError,
  isDuplicateEntryError,
  isIgnorableMigrationError,
  isNoSuchTableError,
  isTableExistsError,
} from './schemaErrors.js';

/** On Neon/Postgres, schema comes from npm run db:migrate:postgres — skip runtime MySQL DDL. */
export function skipRuntimeSchemaOnPostgres() {
  return isPostgres();
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
