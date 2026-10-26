import { d, round2, type Dec, type DecInput } from "@softilo/domain";
import { daysBetween } from "./dates.js";

/**
 * Permanent placements: the fee is a percentage of first-year salary. If the candidate leaves within
 * the rebate period, the client gets back a share of the fee by a sliding scale in the terms of business.
 */
export function permFee(salary: DecInput, feePct: DecInput): Dec {
  return round2(d(salary).times(feePct).dividedBy(100));
}

/** A rebate band: if the candidate leaves within `withinDays` of starting, refund `refundPct` of the fee. */
export interface RebateBand {
  withinDays: number;
  refundPct: DecInput;
}

/** A common UK sliding scale; every agency sets its own in its terms of business. */
export const DEFAULT_REBATE_SCALE: RebateBand[] = [
  { withinDays: 28, refundPct: 100 },
  { withinDays: 56, refundPct: 75 },
  { withinDays: 84, refundPct: 50 },
  { withinDays: 112, refundPct: 25 },
];

/** Rebate due when a placed candidate leaves on `leftOn` after starting on `startedOn`. */
export function permRebate(fee: DecInput, startedOn: string, leftOn: string, scale: RebateBand[] = DEFAULT_REBATE_SCALE): Dec {
  const days = daysBetween(startedOn, leftOn);
  if (days < 0) throw new Error("The leaving date is before the start date");
  const band = [...scale].sort((a, b) => a.withinDays - b.withinDays).find((b) => days < b.withinDays);
  return band ? round2(d(fee).times(band.refundPct).dividedBy(100)) : d(0);
}
