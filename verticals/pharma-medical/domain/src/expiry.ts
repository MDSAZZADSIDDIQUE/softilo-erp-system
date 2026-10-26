/**
 * Expiry dates. Packs often print month and year only ("EXP 03/2027"); GDP practice treats those
 * as expiring at the end of that month. A product can be supplied up to and including its expiry date.
 */

const FULL = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^(\d{4})-(\d{2})$/;

export class InvalidDateError extends Error {}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Accept YYYY-MM-DD or YYYY-MM and return an ISO date (month-only becomes the last day of that month). */
export function normaliseExpiry(input: string): string {
  const s = input.trim();
  const m = MONTH.exec(s);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) throw new InvalidDateError(`"${input}" is not a valid expiry month`);
    return `${m[1]}-${m[2]}-${String(lastDayOfMonth(year, month)).padStart(2, "0")}`;
  }
  const f = FULL.exec(s);
  if (!f) throw new InvalidDateError(`"${input}" is not a date; use YYYY-MM-DD or YYYY-MM`);
  const [year, month, day] = [Number(f[1]), Number(f[2]), Number(f[3])];
  if (month < 1 || month > 12 || day < 1 || day > lastDayOfMonth(year, month)) {
    throw new InvalidDateError(`"${input}" is not a real date`);
  }
  return s;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * True when stock with this expiry may be supplied on `onDate` while leaving the customer at least
 * `minShelfLifeDays` of shelf life (0 = usable up to and including the expiry date).
 */
export function isInDate(expiry: string, onDate: string, minShelfLifeDays = 0): boolean {
  return expiry >= addDays(onDate, minShelfLifeDays);
}

export type ExpiryBand = "expired" | "30" | "90" | "180" | "ok";

/** Bucket for expiry dashboards: expired, or expiring within 30 / 90 / 180 days. */
export function expiryBand(expiry: string, onDate: string): ExpiryBand {
  const days = daysBetween(onDate, expiry);
  if (days < 0) return "expired";
  if (days <= 30) return "30";
  if (days <= 90) return "90";
  if (days <= 180) return "180";
  return "ok";
}
