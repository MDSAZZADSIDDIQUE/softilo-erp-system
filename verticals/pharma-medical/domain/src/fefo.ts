import { d, ZERO, type Dec, type DecInput } from "@softilo/domain";
import type { BatchStatus } from "./batch-status.js";
import { isInDate } from "./expiry.js";

/**
 * First-expiry, first-out allocation. Only released batches that are still in date on the supply
 * date, with at least the customer's minimum remaining shelf life, may be allocated.
 */

export interface BatchStock {
  id: string;
  batchNumber: string;
  expiry: string;
  status: BatchStatus;
  onHand: DecInput;
  receivedOn: string;
}

export interface Allocation {
  batchId: string;
  batchNumber: string;
  expiry: string;
  quantity: Dec;
}

export interface FefoOptions {
  onDate: string;
  minShelfLifeDays?: number;
}

/** Stock on hand that could not be sold, by reason. */
export interface Unsellable {
  quarantine: Dec;
  shortDated: Dec;
  expired: Dec;
  blocked: Dec;
}

export class InsufficientReleasedStockError extends Error {
  constructor(public requested: Dec, public sellable: Dec, public unsellable: Unsellable) {
    const parts = [
      unsellable.quarantine.isZero() ? "" : `${unsellable.quarantine} in quarantine`,
      unsellable.shortDated.isZero() ? "" : `${unsellable.shortDated} short-dated`,
      unsellable.expired.isZero() ? "" : `${unsellable.expired} expired`,
      unsellable.blocked.isZero() ? "" : `${unsellable.blocked} rejected or recalled`,
    ].filter(Boolean);
    super(`Only ${sellable} released, in-date units available; ${requested} requested`
      + (parts.length ? ` (also on hand: ${parts.join(", ")})` : ""));
  }
}

export function fefoOrder(a: BatchStock, b: BatchStock): number {
  if (a.expiry !== b.expiry) return a.expiry < b.expiry ? -1 : 1;
  if (a.receivedOn !== b.receivedOn) return a.receivedOn < b.receivedOn ? -1 : 1;
  return a.batchNumber < b.batchNumber ? -1 : a.batchNumber > b.batchNumber ? 1 : 0;
}

export function isSellable(b: BatchStock, opts: FefoOptions): boolean {
  return b.status === "released" && d(b.onHand).greaterThan(0) && isInDate(b.expiry, opts.onDate, opts.minShelfLifeDays ?? 0);
}

/** Sellable batches in FEFO order. */
export function sellableBatches(batches: BatchStock[], opts: FefoOptions): BatchStock[] {
  return batches.filter((b) => isSellable(b, opts)).sort(fefoOrder);
}

export function allocateFefo(batches: BatchStock[], quantity: DecInput, opts: FefoOptions): Allocation[] {
  const requested = d(quantity);
  if (requested.lessThanOrEqualTo(0)) throw new Error("Quantity must be positive");
  const allocations: Allocation[] = [];
  let remaining = requested;
  for (const b of sellableBatches(batches, opts)) {
    if (remaining.isZero()) break;
    const onHand = d(b.onHand);
    const take = remaining.lessThan(onHand) ? remaining : onHand;
    allocations.push({ batchId: b.id, batchNumber: b.batchNumber, expiry: b.expiry, quantity: take });
    remaining = remaining.minus(take);
  }
  if (remaining.greaterThan(0)) {
    throw new InsufficientReleasedStockError(requested, requested.minus(remaining), unsellable(batches, opts));
  }
  return allocations;
}

function unsellable(batches: BatchStock[], opts: FefoOptions): Unsellable {
  const u: Unsellable = { quarantine: ZERO, shortDated: ZERO, expired: ZERO, blocked: ZERO };
  for (const b of batches) {
    const q = d(b.onHand);
    if (q.lessThanOrEqualTo(0) || isSellable(b, opts)) continue;
    if (b.status === "rejected" || b.status === "recalled") u.blocked = u.blocked.plus(q);
    else if (!isInDate(b.expiry, opts.onDate)) u.expired = u.expired.plus(q);
    else if (b.status === "quarantine") u.quarantine = u.quarantine.plus(q);
    else u.shortDated = u.shortDated.plus(q);
  }
  return u;
}
