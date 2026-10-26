import { d, round2, type Dec, type DecInput } from "@softilo/domain";

/** UK firms record time in units of six minutes (a tenth of an hour). */
export const UNIT_MINUTES = 6;

export class InvalidTimeError extends Error {}

/** Whole minutes become units, rounded up: 1–6 minutes is one unit, 7–12 is two. */
export function timeUnits(minutes: number): number {
  if (!Number.isInteger(minutes) || minutes <= 0) throw new InvalidTimeError("Time must be a whole number of minutes greater than zero");
  if (minutes > 24 * 60) throw new InvalidTimeError("A single time entry cannot exceed 24 hours");
  return Math.ceil(minutes / UNIT_MINUTES);
}

/** Value of a time entry: units × (hourly rate ÷ 10), to the penny. */
export function timeValue(minutes: number, hourlyRate: DecInput): Dec {
  const rate = d(hourlyRate);
  if (rate.isNegative()) throw new InvalidTimeError("Hourly rate cannot be negative");
  return round2(rate.times(timeUnits(minutes)).dividedBy(10));
}
