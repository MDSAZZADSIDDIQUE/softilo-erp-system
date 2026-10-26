import { d, round2, round6, ZERO, type Dec, type DecInput } from "./money.js";

/**
 * Weighted-average stock costing for one SKU in one warehouse.
 * Value is held in pence so the stock ledger always equals the stock account.
 */
export interface StockPosition {
  quantity: Dec;
  value: Dec;
}

export const EMPTY_POSITION: StockPosition = { quantity: ZERO, value: ZERO };

export function averageCost(p: StockPosition): Dec {
  return p.quantity.isZero() ? ZERO : round6(p.value.dividedBy(p.quantity));
}

export function receive(p: StockPosition, quantity: DecInput, value: DecInput): StockPosition {
  const q = d(quantity);
  if (q.isNegative() || q.isZero()) throw new Error("Receipt quantity must be positive");
  return { quantity: p.quantity.plus(q), value: p.value.plus(round2(value)) };
}

/** Value-only adjustment (e.g. a landed-cost true-up) on the stock still on hand. */
export function revalue(p: StockPosition, value: DecInput): StockPosition {
  if (p.quantity.isZero()) throw new Error("Cannot revalue a SKU with no stock on hand");
  return { quantity: p.quantity, value: p.value.plus(round2(value)) };
}

export class InsufficientStockError extends Error {
  constructor(public available: Dec, public requested: Dec) {
    super(`Insufficient stock: ${available.toString()} available, ${requested.toString()} requested`);
  }
}

/**
 * Issue stock at average cost. Issuing everything on hand takes the full remaining value,
 * so rounding never leaves pennies stranded against zero quantity.
 */
export function issue(p: StockPosition, quantity: DecInput): { cost: Dec; position: StockPosition } {
  const q = d(quantity);
  if (q.isNegative() || q.isZero()) throw new Error("Issue quantity must be positive");
  if (q.greaterThan(p.quantity)) throw new InsufficientStockError(p.quantity, q);
  const cost = q.equals(p.quantity) ? p.value : round2(p.value.times(q).dividedBy(p.quantity));
  return { cost, position: { quantity: p.quantity.minus(q), value: p.value.minus(cost) } };
}
