import { d, round2, sum, type Dec, type DecInput } from "./money.js";

export type AllocationMethod = "value" | "weight" | "volume" | "quantity" | "manual";

export interface ReceiptLineBasis {
  id: string;
  quantity: DecInput;
  /** Goods value in GBP. */
  value: DecInput;
  weight?: DecInput;
  volume?: DecInput;
  /** Share used when method is "manual" (any positive weights; they are normalised). */
  manualShare?: DecInput;
}

export interface CostLine {
  id: string;
  /** Amount in GBP. */
  amount: DecInput;
  method: AllocationMethod;
}

export interface Allocation {
  costLineId: string;
  receiptLineId: string;
  amount: Dec;
}

function basis(line: ReceiptLineBasis, method: AllocationMethod): Dec {
  switch (method) {
    case "value": return d(line.value);
    case "quantity": return d(line.quantity);
    case "weight": return d(line.weight ?? 0);
    case "volume": return d(line.volume ?? 0);
    case "manual": return d(line.manualShare ?? 0);
  }
}

/**
 * Split `total` across `weights` in pence so the parts add up exactly to the total.
 * Largest-remainder method: everyone gets the floor of their share, then the leftover
 * pennies go to the largest fractional remainders (ties broken by input order).
 */
export function splitPence(total: DecInput, weights: DecInput[]): Dec[] {
  const totalPence = round2(total).times(100);
  const ws = weights.map((w) => d(w));
  const wSum = sum(ws);
  if (wSum.isZero()) throw new Error("Cannot allocate: every line has a zero basis for this method");
  if (ws.some((w) => w.isNegative())) throw new Error("Allocation basis cannot be negative");

  const negative = totalPence.isNegative();
  const abs = totalPence.abs();
  const exact = ws.map((w) => abs.times(w).dividedBy(wSum));
  const floors = exact.map((x) => x.floor());
  let leftover = abs.minus(sum(floors)).toNumber();
  const order = exact
    .map((x, i) => ({ i, rem: x.minus(floors[i]!) }))
    .sort((a, b) => b.rem.comparedTo(a.rem) || a.i - b.i);
  const pence = [...floors];
  for (let k = 0; leftover > 0; k++, leftover--) {
    const idx = order[k % order.length]!.i;
    pence[idx] = pence[idx]!.plus(1);
  }
  return pence.map((p) => (negative ? p.neg() : p).dividedBy(100));
}

/** Allocate each cost line across the receipt lines by its method. */
export function allocateLandedCosts(lines: ReceiptLineBasis[], costs: CostLine[]): Allocation[] {
  if (lines.length === 0) throw new Error("A shipment needs at least one receipt line");
  const out: Allocation[] = [];
  for (const c of costs) {
    const parts = splitPence(c.amount, lines.map((l) => basis(l, c.method)));
    lines.forEach((l, i) => out.push({ costLineId: c.id, receiptLineId: l.id, amount: parts[i]! }));
  }
  return out;
}

/** Total allocated cost per receipt line. */
export function totalsByReceiptLine(allocs: Allocation[]): Map<string, Dec> {
  const m = new Map<string, Dec>();
  for (const a of allocs) m.set(a.receiptLineId, (m.get(a.receiptLineId) ?? d(0)).plus(a.amount));
  return m;
}
