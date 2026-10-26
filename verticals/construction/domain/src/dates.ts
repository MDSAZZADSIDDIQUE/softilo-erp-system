/** Date helpers on ISO YYYY-MM-DD strings, in UTC so they never drift with the server's time zone. */
export function addDays(date: string, days: number): string {
  const dt = new Date(`${date}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function ymd(y: number, m: number, day: number): string {
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.toISOString().slice(0, 10);
}

export function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

/**
 * A CIS tax month runs from the 6th of one month to the 5th of the next. It is named by its
 * last day ("month ending 5 November 2026"). The return must reach HMRC by the 19th, the
 * deductions must be paid by the 22nd (19th by post), and subcontractors must get their
 * payment and deduction statements within 14 days of the end of the month (also the 19th).
 */
export interface TaxMonth {
  start: string;
  end: string;
  /** Tax year label, e.g. "2026-27". */
  taxYear: string;
  /** 1 = month ending 5 May … 12 = month ending 5 April. */
  number: number;
  returnDue: string;
  paymentDue: string;
  paymentDueByPost: string;
  statementsDue: string;
}

export function taxMonthEnding(end: string): TaxMonth {
  if (!/^\d{4}-\d{2}-05$/.test(end)) throw new Error("A CIS tax month ends on the 5th of a month (YYYY-MM-05)");
  const y = Number(end.slice(0, 4));
  const m = Number(end.slice(5, 7));
  const startYear = Number(end.slice(0, 4)) - (m === 1 ? 1 : 0);
  const taxYearStart = m >= 5 ? y : y - 1;
  return {
    start: ymd(startYear, m === 1 ? 12 : m - 1, 6),
    end,
    taxYear: `${taxYearStart}-${String((taxYearStart + 1) % 100).padStart(2, "0")}`,
    number: ((m - 5 + 12) % 12) + 1,
    returnDue: ymd(y, m, 19),
    paymentDue: ymd(y, m, 22),
    paymentDueByPost: ymd(y, m, 19),
    statementsDue: addDays(end, 14),
  };
}

/** The tax month a date falls in. */
export function taxMonthOf(date: string): TaxMonth {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const end = day <= 5 ? ymd(y, m, 5) : ymd(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 5);
  return taxMonthEnding(end);
}
