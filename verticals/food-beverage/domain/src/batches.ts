import { d, sum, ZERO, type Dec, type DecInput } from "@softilo/domain";

/**
 * Batch (lot) rules for food and drink.
 *
 * Use-by is a safety date: food past it must not be supplied, so those batches are never allocated.
 * Best-before is a quality date: the food may still be sold, so those batches are allocated but flagged.
 * Batches track quantity only; value stays at weighted average in the core stock ledger.
 */
export type DateType = "use_by" | "best_before";

export type BatchStatus = "expired" | "past_best_before" | "expiring" | "ok" | "no_date";

export interface BatchStock {
  id: string;
  code: string;
  /** YYYY-MM-DD, or null for batches with no date mark. */
  expiry: string | null;
  dateType: DateType;
  available: DecInput;
  /** Tie-breaker after the date: older receipts go first. */
  receivedOn?: string;
}

export interface FefoOptions {
  /** The despatch date (YYYY-MM-DD). */
  today: string;
  /** Customer's minimum remaining shelf life in days on delivery. */
  minLifeDays?: number;
}

export interface BatchAllocation {
  batchId: string;
  code: string;
  expiry: string | null;
  quantity: Dec;
  /** True when a best-before batch past its date is supplied (allowed, but shown on the invoice). */
  pastBestBefore: boolean;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function dayNumber(date: string): number {
  if (!ISO.test(date)) throw new Error(`Not a date: ${date}`);
  const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  if (Number.isNaN(t)) throw new Error(`Not a date: ${date}`);
  return Math.round(t / 86_400_000);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/** Date mark for a batch: receipt or production date plus the product's shelf life. */
export function expiryFrom(start: string, shelfLifeDays: number): string {
  if (!Number.isInteger(shelfLifeDays) || shelfLifeDays < 0) throw new Error("Shelf life must be a whole number of days");
  return new Date((dayNumber(start) + shelfLifeDays) * 86_400_000).toISOString().slice(0, 10);
}

/** Expiry status on `today`. A use-by batch may be supplied up to and including its use-by date. */
export function batchStatus(b: Pick<BatchStock, "expiry" | "dateType">, today: string, warnDays = 7): BatchStatus {
  if (!b.expiry) return "no_date";
  const left = daysBetween(today, b.expiry);
  if (left < 0) return b.dateType === "use_by" ? "expired" : "past_best_before";
  return left <= warnDays ? "expiring" : "ok";
}

/** Why a batch cannot be supplied on `today`, or null if it can. */
export function unsellableReason(b: Pick<BatchStock, "expiry" | "dateType" | "code">, opts: FefoOptions): string | null {
  if (!b.expiry) return null;
  const left = daysBetween(opts.today, b.expiry);
  if (b.dateType === "use_by" && left < 0) return `Batch ${b.code} is past its use-by date (${b.expiry})`;
  const min = opts.minLifeDays ?? 0;
  if (min > 0 && left < min) return `Batch ${b.code} has ${Math.max(left, 0)} days of life left; the customer needs at least ${min}`;
  return null;
}

/** First expiry, first out: earliest date first, undated batches last, then oldest receipt, then batch code. */
export function fefoOrder<T extends BatchStock>(batches: T[]): T[] {
  return [...batches].sort((a, b) =>
    (a.expiry ?? "9999-12-31").localeCompare(b.expiry ?? "9999-12-31")
    || (a.receivedOn ?? "").localeCompare(b.receivedOn ?? "")
    || a.code.localeCompare(b.code));
}

export class InsufficientBatchStockError extends Error {
  constructor(public available: Dec, public requested: Dec, public blocked: string[]) {
    super(`Only ${available.toString()} can be supplied from sellable batches, ${requested.toString()} requested`
      + (blocked.length ? `. Not allocated: ${blocked.join("; ")}` : ""));
  }
}

function allocation(b: BatchStock, quantity: Dec, today: string): BatchAllocation {
  return {
    batchId: b.id, code: b.code, expiry: b.expiry, quantity,
    pastBestBefore: b.dateType === "best_before" && b.expiry !== null && daysBetween(today, b.expiry) < 0,
  };
}

/** Allocate `quantity` across batches in FEFO order, skipping batches that cannot be supplied. */
export function allocateFefo(batches: BatchStock[], quantity: DecInput, opts: FefoOptions): BatchAllocation[] {
  const wanted = d(quantity);
  if (!wanted.isPositive()) throw new Error("Quantity must be positive");
  const result: BatchAllocation[] = [];
  const blocked: string[] = [];
  let left = wanted;
  for (const b of fefoOrder(batches)) {
    if (left.isZero()) break;
    const available = d(b.available);
    if (!available.isPositive()) continue;
    const reason = unsellableReason(b, opts);
    if (reason) {
      blocked.push(reason);
      continue;
    }
    const take = available.lessThan(left) ? available : left;
    result.push(allocation(b, take, opts.today));
    left = left.minus(take);
  }
  if (!left.isZero()) throw new InsufficientBatchStockError(wanted.minus(left), wanted, blocked);
  return result;
}

/** Check batches picked by hand: each must exist, be sellable and have enough stock, and they must add up. */
export function checkManualAllocation(
  batches: BatchStock[], picks: { batchId: string; quantity: DecInput }[], quantity: DecInput, opts: FefoOptions,
): BatchAllocation[] {
  const byId = new Map(batches.map((b) => [b.id, b]));
  const used = new Map<string, Dec>();
  const result = picks.map((p) => {
    const b = byId.get(p.batchId);
    if (!b) throw new Error("A chosen batch does not belong to this product and warehouse");
    const q = d(p.quantity);
    if (!q.isPositive()) throw new Error("Batch quantities must be positive");
    const total = (used.get(b.id) ?? ZERO).plus(q);
    if (total.greaterThan(b.available)) throw new Error(`Batch ${b.code} has only ${d(b.available).toString()} available`);
    used.set(b.id, total);
    const reason = unsellableReason(b, opts);
    if (reason) throw new Error(reason);
    return allocation(b, q, opts.today);
  });
  const picked = sum(result.map((r) => r.quantity));
  if (!picked.equals(quantity)) throw new Error(`Batch quantities add up to ${picked.toString()}, but the line is for ${d(quantity).toString()}`);
  return result;
}
