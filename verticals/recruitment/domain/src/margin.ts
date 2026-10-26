import { round2, ZERO, type Dec, type DecInput } from "@softilo/domain";

export interface MarginInput {
  key: string;
  label: string;
  hours: DecInput;
  charge: DecInput;
  cost: DecInput;
}

export interface MarginRow {
  key: string;
  label: string;
  hours: Dec;
  charge: Dec;
  cost: Dec;
  margin: Dec;
  /** Margin as a percentage of charge (sales), 2 dp; null when there is no charge. */
  marginPct: Dec | null;
  /** Gross profit per hour worked. */
  marginPerHour: Dec | null;
}

function finish(key: string, label: string, hours: Dec, charge: Dec, cost: Dec): MarginRow {
  const margin = charge.minus(cost);
  return {
    key, label, hours, charge, cost, margin,
    marginPct: charge.isZero() ? null : round2(margin.dividedBy(charge).times(100)),
    marginPerHour: hours.isZero() ? null : round2(margin.dividedBy(hours)),
  };
}

/** Group margin lines (one per timesheet, usually) by key, largest margin first, plus a total. */
export function marginReport(rows: MarginInput[]): { rows: MarginRow[]; total: MarginRow } {
  const groups = new Map<string, { label: string; hours: Dec; charge: Dec; cost: Dec }>();
  let hours = ZERO, charge = ZERO, cost = ZERO;
  for (const r of rows) {
    const g = groups.get(r.key) ?? { label: r.label, hours: ZERO, charge: ZERO, cost: ZERO };
    g.hours = g.hours.plus(r.hours);
    g.charge = g.charge.plus(r.charge);
    g.cost = g.cost.plus(r.cost);
    groups.set(r.key, g);
    hours = hours.plus(r.hours);
    charge = charge.plus(r.charge);
    cost = cost.plus(r.cost);
  }
  const out = [...groups].map(([key, g]) => finish(key, g.label, g.hours, g.charge, g.cost))
    .sort((a, b) => b.margin.comparedTo(a.margin) || a.label.localeCompare(b.label));
  return { rows: out, total: finish("total", "Total", hours, charge, cost) };
}
