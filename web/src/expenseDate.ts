/** Calendar dates stay in the user's timezone; UTC is only used for arithmetic. */
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function shiftExpenseDate(value: string, days: number): string {
  const date = new Date(`${value || localToday()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) {
    return value;
  }
  return date.toISOString().slice(0, 10);
}
