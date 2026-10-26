import { d, round2, sum, ZERO, type Dec, type DecInput } from "@softilo/domain";
import { addDays } from "./dates.js";

export interface RateCardLine {
  rateType: string;
  payRate: DecInput;
  chargeRate: DecInput;
}

export interface TimesheetEntry {
  date: string;
  rateType: string;
  hours: DecInput;
}

export interface TimesheetCheckInput {
  weekEnding: string;
  placementStart: string;
  placementEnd?: string | null;
  rates: RateCardLine[];
  entries: TimesheetEntry[];
}

/** The seven days covered by a timesheet: weekEnding − 6 … weekEnding. */
export function weekDays(weekEnding: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekEnding, i - 6));
}

/** Returns the problems with a timesheet; empty when it can be submitted. */
export function checkTimesheet(t: TimesheetCheckInput): string[] {
  const errors: string[] = [];
  if (t.entries.length === 0) errors.push("Enter the hours worked");
  const days = new Set(weekDays(t.weekEnding));
  const types = new Set(t.rates.map((r) => r.rateType));
  const perDay = new Map<string, Dec>();
  for (const e of t.entries) {
    const h = d(e.hours);
    if (!h.isPositive()) errors.push(`Hours on ${e.date} must be more than zero`);
    if (h.decimalPlaces() > 2) errors.push(`Hours on ${e.date} can have at most 2 decimal places`);
    if (!days.has(e.date)) errors.push(`${e.date} is not in the week ending ${t.weekEnding}`);
    if (e.date < t.placementStart) errors.push(`${e.date} is before the placement started`);
    if (t.placementEnd && e.date > t.placementEnd) errors.push(`${e.date} is after the placement ended`);
    if (!types.has(e.rateType)) errors.push(`"${e.rateType}" is not a rate on this placement`);
    perDay.set(e.date, (perDay.get(e.date) ?? ZERO).plus(h));
  }
  for (const [date, h] of perDay) if (h.greaterThan(24)) errors.push(`More than 24 hours entered on ${date}`);
  return errors;
}

export interface PricedRate {
  rateType: string;
  hours: Dec;
  payRate: Dec;
  chargeRate: Dec;
  pay: Dec;
  charge: Dec;
}

export interface PricedTimesheet {
  byRate: PricedRate[];
  hours: Dec;
  /** Basic pay for hours worked. */
  pay: Dec;
  /** Holiday pay accrued on top (rolled-up rate), for agency-employed (PAYE) workers. */
  holiday: Dec;
  /** Employer NI, pension and levy estimate, as a rate on pay plus holiday. */
  onCosts: Dec;
  /** What the client is charged, net of VAT. */
  charge: Dec;
  /** Total cost to the agency. */
  cost: Dec;
  margin: Dec;
}

export interface PricingOptions {
  holidayRate?: DecInput;
  onCostRate?: DecInput;
}

/**
 * Price a timesheet. Hours are totalled per rate type before multiplying, so the invoice line
 * (hours × charge rate) always equals the timesheet's charge to the penny.
 */
export function priceTimesheet(rates: RateCardLine[], entries: TimesheetEntry[], opts: PricingOptions = {}): PricedTimesheet {
  const hoursByType = new Map<string, Dec>();
  for (const e of entries) hoursByType.set(e.rateType, (hoursByType.get(e.rateType) ?? ZERO).plus(e.hours));
  const byRate: PricedRate[] = [];
  for (const r of rates) {
    const hours = hoursByType.get(r.rateType);
    if (!hours || hours.isZero()) continue;
    byRate.push({
      rateType: r.rateType, hours, payRate: d(r.payRate), chargeRate: d(r.chargeRate),
      pay: round2(hours.times(r.payRate)), charge: round2(hours.times(r.chargeRate)),
    });
    hoursByType.delete(r.rateType);
  }
  if (hoursByType.size) throw new Error(`No rate for ${[...hoursByType.keys()].join(", ")}`);
  const pay = sum(byRate.map((r) => r.pay));
  const holiday = round2(pay.times(opts.holidayRate ?? 0));
  const onCosts = round2(pay.plus(holiday).times(opts.onCostRate ?? 0));
  const charge = sum(byRate.map((r) => r.charge));
  const cost = pay.plus(holiday).plus(onCosts);
  return { byRate, hours: sum(byRate.map((r) => r.hours)), pay, holiday, onCosts, charge, cost, margin: charge.minus(cost) };
}

export type TimesheetStatus = "draft" | "submitted" | "approved" | "rejected" | "invoiced";

const TRANSITIONS: Record<TimesheetStatus, TimesheetStatus[]> = {
  draft: ["submitted"],
  submitted: ["approved", "rejected"],
  rejected: ["submitted"],
  approved: ["invoiced"],
  invoiced: [],
};

export function canTransition(from: TimesheetStatus, to: TimesheetStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Hours (and so pay and charges) can only change before approval. */
export function isEditable(status: TimesheetStatus): boolean {
  return status === "draft" || status === "rejected";
}
