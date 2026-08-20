import { createPool } from "./createPool.js";
import { convertNamedParams, convertPositionalParams } from "./params.js";
import {
  isDuplicateColumnError,
  isDuplicateEntryError,
  isIgnorableMigrationError,
  isNoSuchTableError,
  isBadFieldError,
  isTableExistsError
} from "./schemaErrors.js";
function getPool() {
  return createPool();
}
function getDatabaseEnvSummary() {
  const url = process.env.DATABASE_URL || "";
  let host = null;
  try {
    host = url ? new URL(url).hostname : null;
  } catch {
    host = null;
  }
  return {
    provider: "postgres",
    engine: "postgresql",
    host,
    configured: Boolean(process.env.DATABASE_URL)
  };
}
export {
  convertNamedParams,
  convertPositionalParams,
  getDatabaseEnvSummary,
  getPool,
  isBadFieldError,
  isDuplicateColumnError,
  isDuplicateEntryError,
  isIgnorableMigrationError,
  isNoSuchTableError,
  isTableExistsError
};
