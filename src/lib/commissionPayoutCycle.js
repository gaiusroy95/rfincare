/**
 * Commission payout cycle: work earned in month M is paid on the 15th of month M+1.
 * Returns the next upcoming payout date (always the 15th).
 *
 * @param {Date} [fromDate]
 * @returns {Date}
 */
export function getNextCommissionPayoutDate(fromDate = new Date()) {
  const d = fromDate instanceof Date ? new Date(fromDate) : new Date(fromDate);
  if (Number.isNaN(d.getTime())) {
    return getNextCommissionPayoutDate(new Date());
  }
  const year = d.getFullYear();
  const month = d.getMonth();
  const day = d.getDate();

  if (day < 15) {
    return new Date(year, month, 15);
  }
  return new Date(year, month + 1, 15);
}

/** ISO date string (YYYY-MM-DD) for API payloads. */
export function getNextCommissionPayoutDateIso(fromDate = new Date()) {
  const next = getNextCommissionPayoutDate(fromDate);
  const y = next.getFullYear();
  const m = String(next.getMonth() + 1).padStart(2, '0');
  const day = String(next.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
