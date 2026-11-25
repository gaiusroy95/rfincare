/**
 * SQL fragments for loan_applications fields that live inside the `data` JSON column.
 * loan_applications has no loan_type / loan_amount columns — referencing them directly
 * fails with `column "loan_type" does not exist` (Reports & Analytics).
 */

function col(alias, key) {
  const prefix = alias ? `${alias}.` : '';
  return `NULLIF(TRIM(CAST(${prefix}data->>'${key}' AS TEXT)), '')`;
}

/** Loan product key, e.g. personal_loan (falls back to purpose fields). */
export function laLoanTypeSql(alias = 'la') {
  return `COALESCE(${col(alias, 'loan_type')}, ${col(alias, 'loan_purpose')}, ${col(alias, 'loanType')}, ${col(alias, 'loanPurpose')})`;
}

/** Requested loan amount as numeric (NULL when missing or not a plain number). */
export function laLoanAmountSql(alias = 'la') {
  const raw = `REPLACE(COALESCE(${col(alias, 'loan_amount')}, ${col(alias, 'requested_loan_amount')}, ${col(alias, 'loanAmount')}, ${col(alias, 'requestedLoanAmount')}), ',', '')`;
  return `(CASE WHEN ${raw} ~ '^[0-9]+(\\.[0-9]+)?$' THEN CAST(${raw} AS NUMERIC) END)`;
}
