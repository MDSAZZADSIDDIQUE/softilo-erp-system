import { addDays, daysBetween } from "./dates.js";

/**
 * Agency Workers Regulations 2010 (SI 2010/93): after 12 qualifying weeks in the same role with the same hirer,
 * an agency worker is entitled to the same basic working and employment conditions as a direct recruit.
 *
 * Model used here (a simplification of regulation 7; check edge cases against the legislation):
 *   - A "week" is 7 days starting on the first day of the first assignment (reg. 7(4)); any work in it counts.
 *   - Weeks off for pregnancy, childbirth or maternity (up to 26 weeks after childbirth), and maternity,
 *     paternity, adoption or shared parental leave count as if worked (reg. 7(9)).
 *   - Weeks off for annual leave, a hirer shutdown, or a strike/lock-out pause the clock (no limit).
 *   - Sickness/injury and jury service pause the clock for up to 28 weeks; a longer run resets it.
 *   - Any other break pauses the clock for up to 6 calendar weeks; a seventh consecutive week resets it.
 *   - A new, substantively different role with the same hirer also resets it (record that as a new AWR start).
 */
export type AbsenceReason =
  | "annual_leave" | "sickness" | "jury_service" | "hirer_shutdown" | "strike"
  | "pregnancy_maternity" | "family_leave" | "other";

export const ABSENCE_LABEL: Record<AbsenceReason, string> = {
  annual_leave: "Annual leave",
  sickness: "Sickness or injury",
  jury_service: "Jury service",
  hirer_shutdown: "Hirer shutdown",
  strike: "Strike or lock-out",
  pregnancy_maternity: "Pregnancy, childbirth or maternity",
  family_leave: "Maternity, paternity, adoption or shared parental leave",
  other: "Other break",
};

const COUNTS_AS_WORKED: AbsenceReason[] = ["pregnancy_maternity", "family_leave"];
const PAUSE_UNLIMITED: AbsenceReason[] = ["annual_leave", "hirer_shutdown", "strike"];
const PAUSE_28_WEEKS: AbsenceReason[] = ["sickness", "jury_service"];

export const QUALIFYING_WEEKS = 12;

export interface Absence {
  start: string;
  end: string;
  reason: AbsenceReason;
}

export interface AwrInput {
  /** First day of the first assignment in this role with this hirer. */
  start: string;
  /** Days on which the worker did any work. */
  workedDates: string[];
  absences: Absence[];
  /** Assess up to and including this date. */
  asOf: string;
}

export type AwrWeekOutcome = "worked" | "counted_absence" | "paused" | "break" | "reset";

export interface AwrWeek {
  start: string;
  outcome: AwrWeekOutcome;
  reason?: AbsenceReason;
  /** Qualifying weeks completed at the end of this week. */
  count: number;
}

export interface AwrResult {
  status: "qualified" | "accruing" | "paused" | "reset" | "not_started";
  weeksCompleted: number;
  weeksRemaining: number;
  /** Date equal treatment starts (first day of week 13), once known. */
  qualifiedOn: string | null;
  /** If the worker works every week from now on, the date they would qualify. */
  projectedQualifyingDate: string | null;
  /** The current clock's start (moves forward after a reset). */
  clockStart: string | null;
  weeks: AwrWeek[];
}

function absenceIn(absences: Absence[], from: string, to: string): Absence[] {
  return absences.filter((a) => a.start <= to && a.end >= from);
}

export function assessAwr(input: AwrInput): AwrResult {
  const worked = [...new Set(input.workedDates)].filter((x) => x >= input.start && x <= input.asOf).sort();
  const weeks: AwrWeek[] = [];
  let count = 0;
  let qualifiedOn: string | null = null;
  let clockStart: string | null = worked.length ? input.start : null;
  let breakRun = 0;
  let longPauseRun = 0;
  let lastOutcome: AwrWeekOutcome | null = null;
  let pendingWeek: string | null = null;
  if (!clockStart) {
    return { status: "not_started", weeksCompleted: 0, weeksRemaining: QUALIFYING_WEEKS, qualifiedOn: null,
      projectedQualifyingDate: null, clockStart: null, weeks };
  }
  // Week boundaries are anchored on the current clock's start; a reset re-anchors on the next day worked.
  let weekStart = clockStart;
  let wi = 0;
  while (weekStart <= input.asOf) {
    const weekEnd = addDays(weekStart, 6);
    while (wi < worked.length && worked[wi]! < weekStart) wi++;
    const workedThisWeek = wi < worked.length && worked[wi]! <= weekEnd;
    const abs = absenceIn(input.absences, weekStart, weekEnd);
    let outcome: AwrWeekOutcome;
    let reason: AbsenceReason | undefined;
    const counted = abs.find((a) => COUNTS_AS_WORKED.includes(a.reason));
    const unlimited = abs.find((a) => PAUSE_UNLIMITED.includes(a.reason));
    const limited = abs.find((a) => PAUSE_28_WEEKS.includes(a.reason));
    if (workedThisWeek || counted) {
      outcome = workedThisWeek ? "worked" : "counted_absence";
      reason = workedThisWeek ? undefined : counted!.reason;
      count++;
      breakRun = 0;
      longPauseRun = 0;
    } else if (weekEnd > input.asOf) {
      // The current week is not over and nothing counts yet: it can still be worked.
      pendingWeek = weekStart;
      break;
    } else if (unlimited) {
      outcome = "paused";
      reason = unlimited.reason;
    } else if (limited) {
      reason = limited.reason;
      longPauseRun++;
      outcome = longPauseRun > 28 ? "reset" : "paused";
    } else {
      breakRun++;
      reason = abs[0]?.reason;
      outcome = breakRun > 6 ? "reset" : "break";
    }
    if (count >= QUALIFYING_WEEKS && !qualifiedOn) qualifiedOn = addDays(weekEnd, 1);
    if (outcome === "reset" && !qualifiedOn) {
      weeks.push({ start: weekStart, outcome, reason, count: 0 });
      count = 0;
      breakRun = 0;
      longPauseRun = 0;
      const next = worked.find((x) => x > weekEnd);
      lastOutcome = "reset";
      if (!next) { clockStart = null; break; }
      clockStart = next;
      weekStart = next;
      continue;
    }
    weeks.push({ start: weekStart, outcome, reason, count });
    lastOutcome = outcome;
    weekStart = addDays(weekStart, 7);
  }
  const weeksRemaining = Math.max(0, QUALIFYING_WEEKS - count);
  let status: AwrResult["status"];
  if (qualifiedOn) status = "qualified";
  else if (lastOutcome === "reset" || clockStart === null) status = "reset";
  else if (lastOutcome === "paused" || lastOutcome === "break") status = "paused";
  else status = "accruing";
  let projectedQualifyingDate: string | null = qualifiedOn;
  if (!qualifiedOn && clockStart) {
    // Remaining weeks run from the week after the last assessed one (or this week if it is not yet counted).
    const current = weeks.at(-1);
    const next = pendingWeek ?? (current ? addDays(current.start, 7) : clockStart);
    projectedQualifyingDate = addDays(next, weeksRemaining * 7);
  }
  return { status, weeksCompleted: count, weeksRemaining, qualifiedOn, projectedQualifyingDate, clockStart, weeks };
}

/** Whether a qualifying date falls within `days` of `asOf` (for "qualifying soon" alerts). */
export function qualifiesWithin(result: AwrResult, asOf: string, days: number): boolean {
  if (result.status === "qualified" || !result.projectedQualifyingDate) return false;
  const gap = daysBetween(asOf, result.projectedQualifyingDate);
  return gap >= 0 && gap <= days;
}
