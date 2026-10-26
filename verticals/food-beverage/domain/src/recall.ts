import { d, sum, ZERO, type Dec, type DecInput } from "@softilo/domain";

/** Kinds of batch movement. Quantities are signed: in is positive, out is negative. */
export type BatchMovementKind = "receipt" | "dispatch" | "return" | "write_off" | "adjustment";

export interface TraceMovement {
  kind: BatchMovementKind;
  quantity: DecInput;
  date: string;
  /** Customer (dispatch/return) or supplier (receipt). */
  contactId?: string | null;
  contactName?: string | null;
  document?: string | null;
}

export interface CustomerExposure {
  contactId: string;
  contactName: string;
  /** Net quantity supplied (dispatches less returns). */
  quantity: Dec;
  firstDate: string;
  lastDate: string;
  documents: string[];
}

export interface TraceSummary {
  received: Dec;
  dispatched: Dec;
  returned: Dec;
  writtenOff: Dec;
  adjusted: Dec;
  onHand: Dec;
  /**
   * Every business customer supplied from the batch, largest net quantity first. Customers who returned
   * everything stay on the list (net zero): they still had the food and must be told.
   */
  customers: CustomerExposure[];
}

/**
 * One step forward for a recall: who received how much of a batch, and how much is still on hand.
 * The movements are the batch's whole history, so on hand = Σ movements.
 */
export function summariseTrace(movements: TraceMovement[]): TraceSummary {
  const by = (k: BatchMovementKind) => sum(movements.filter((m) => m.kind === k).map((m) => m.quantity));
  const customers = new Map<string, CustomerExposure>();
  for (const m of movements) {
    if ((m.kind !== "dispatch" && m.kind !== "return") || !m.contactId) continue;
    const c = customers.get(m.contactId) ?? {
      contactId: m.contactId, contactName: m.contactName ?? "", quantity: ZERO, firstDate: m.date, lastDate: m.date, documents: [],
    };
    c.quantity = c.quantity.minus(m.quantity); // dispatches are negative movements
    if (m.date < c.firstDate) c.firstDate = m.date;
    if (m.date > c.lastDate) c.lastDate = m.date;
    if (m.document && !c.documents.includes(m.document)) c.documents.push(m.document);
    customers.set(m.contactId, c);
  }
  return {
    received: by("receipt"),
    dispatched: by("dispatch").neg(),
    returned: by("return"),
    writtenOff: by("write_off").neg(),
    adjusted: by("adjustment"),
    onHand: sum(movements.map((m) => d(m.quantity))),
    customers: [...customers.values()]
      .sort((a, b) => b.quantity.comparedTo(a.quantity) || a.contactName.localeCompare(b.contactName)),
  };
}
