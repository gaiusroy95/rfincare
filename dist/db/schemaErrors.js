function isDuplicateColumnError(err) {
  return err?.code === "42701";
}
function isIgnorableMigrationError(err) {
  return err?.code === "42701" || err?.code === "42710" || err?.code === "42P07" || err?.code === "23505";
}
function isDuplicateEntryError(err) {
  return err?.code === "23505";
}
function isNoSuchTableError(err) {
  return err?.code === "42P01";
}
function isBadFieldError(err) {
  return err?.code === "42703";
}
function isTableExistsError(err) {
  return err?.code === "42P07";
}
function isIgnorableEnsureError(err) {
  return isDuplicateColumnError(err) || isIgnorableMigrationError(err) || isDuplicateEntryError(err) || isTableExistsError(err) || isNoSuchTableError(err) || isBadFieldError(err);
}
export {
  isBadFieldError,
  isDuplicateColumnError,
  isDuplicateEntryError,
  isIgnorableEnsureError,
  isIgnorableMigrationError,
  isNoSuchTableError,
  isTableExistsError
};
