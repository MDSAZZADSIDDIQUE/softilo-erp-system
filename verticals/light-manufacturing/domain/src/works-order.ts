import {
  cr, d, dr, finalise, round2, splitPence, sum, ZERO,
  type Dec, type DecInput, type JournalLine, type Posting, type RoleMap,
} from "@softilo/domain";
import type { MfgRoleMap } from "./accounts.js";
import type { WorkCentreRates } from "./bom.js";

/**
 * Works-order posting rules. Value flows Stock → WIP (materials at average cost, labour and
 * overhead absorbed at standard rates) → Stock (finished goods at the order's actual WIP cost),
 * with abnormal scrap and any residual written off. Every rule returns one balanced journal.
 */

export interface MaterialIssueInput {
  date: string;
  reference: string;
  /** Cost of each component issued, from the costing engine. Negative = returned to stock. */
  lines: { costGbp: DecInput; description?: string }[];
}

/** Components issued to a works order: Dr WIP, Cr Stock. */
export function postMaterialIssue(acc: RoleMap, mfg: MfgRoleMap, m: MaterialIssueInput): Posting {
  const lines: JournalLine[] = [];
  for (const l of m.lines) {
    lines.push(dr(mfg.wip, l.costGbp, l.description));
    lines.push(cr(acc.stock, l.costGbp, l.description));
  }
  return { journal: finalise({ date: m.date, memo: `Materials issued ${m.reference}`, lines }), vat: [] };
}

/** Labour and overhead absorbed for `hours` at a work centre's standard rates, to the penny. */
export function conversionCost(hours: DecInput, rates: WorkCentreRates): { labour: Dec; overhead: Dec } {
  const h = d(hours);
  if (!h.greaterThan(0)) throw new Error("Hours must be positive");
  return { labour: round2(h.times(rates.labourRate)), overhead: round2(h.times(rates.overheadRate)) };
}

export interface ConversionInput {
  date: string;
  reference: string;
  labourGbp: DecInput;
  overheadGbp: DecInput;
  description?: string;
}

/** Time booked: Dr WIP, Cr Labour absorbed; Dr WIP, Cr Overheads absorbed. */
export function postConversion(mfg: MfgRoleMap, c: ConversionInput): Posting {
  return {
    journal: finalise({
      date: c.date,
      memo: `Labour and overhead absorbed ${c.reference}`,
      lines: [
        dr(mfg.wip, c.labourGbp, "Labour"),
        cr(mfg.labour_absorbed, c.labourGbp, c.description),
        dr(mfg.wip, c.overheadGbp, "Overhead"),
        cr(mfg.overhead_absorbed, c.overheadGbp, c.description),
      ],
    }),
    vat: [],
  };
}

export interface CompletionCostInput {
  /** Current WIP balance on the order, in GBP. */
  wip: DecInput;
  /** Units still to be accounted for on the order (quantity − completed − scrapped so far). */
  remaining: DecInput;
  good: DecInput;
  scrap: DecInput;
  /** Close the order: clear the whole WIP balance. */
  final: boolean;
}

export interface CompletionCost {
  good: Dec;
  scrap: Dec;
  /** WIP left with no units to absorb it, only on a final completion. */
  variance: Dec;
  /** WIP balance after this completion (always zero when final). */
  wipAfter: Dec;
}

/**
 * Value taken out of WIP for a completion. A part completion takes the WIP balance in proportion
 * to units: WIP × (good + scrap) ÷ max(remaining, good + scrap). A final completion takes all of it.
 * The amount is split between good and scrapped units by quantity, to the penny.
 */
export function completionCost(c: CompletionCostInput): CompletionCost {
  const wip = round2(c.wip);
  const good = d(c.good);
  const scrap = d(c.scrap);
  if (good.isNegative() || scrap.isNegative()) throw new Error("Quantities cannot be negative");
  const units = good.plus(scrap);
  if (units.isZero()) {
    if (!c.final) throw new Error("Complete or scrap at least one unit, or close the order");
    return { good: ZERO, scrap: ZERO, variance: wip, wipAfter: ZERO };
  }
  const remaining = d(c.remaining);
  const taken = c.final ? wip : round2(wip.times(units).dividedBy(units.greaterThan(remaining) ? units : remaining));
  const [g, s] = splitPence(taken, [good, scrap]) as [Dec, Dec];
  return { good: g, scrap: s, variance: ZERO, wipAfter: wip.minus(taken) };
}

export interface CompletionInput {
  date: string;
  reference: string;
  cost: CompletionCost;
  description?: string;
}

/** Finished goods into stock (Dr Stock), abnormal scrap and residual written off, all Cr WIP. */
export function postCompletion(acc: RoleMap, mfg: MfgRoleMap, c: CompletionInput): Posting {
  const { good, scrap, variance } = c.cost;
  return {
    journal: finalise({
      date: c.date,
      memo: `Works order completion ${c.reference}`,
      lines: [
        dr(acc.stock, good, c.description),
        dr(mfg.scrap, scrap, c.description),
        dr(mfg.production_variance, variance, c.description),
        cr(mfg.wip, sum([good, scrap, variance]), c.description),
      ],
    }),
    vat: [],
  };
}
