import {
  cr, d, dr, finalise, round2, sum, vatCode as vatCodeDef, type Dec, type DecInput, type JournalLine,
  type Posting, type RoleMap, type VatCode, type VatEntry,
} from "@softilo/domain";
import type { EcomAccounts } from "./accounts.js";

/** What happens to a returned item: back on the shelf, or written off (damaged, used, unsellable). */
export type Disposition = "restock" | "write_off";

/** An invoice line being returned, with what earlier returns have already credited against it. */
export interface ReturnableLine {
  id: string;
  description: string;
  quantity: DecInput;
  net: DecInput;
  vat: DecInput;
  vatCode: VatCode;
  account: string;
  costGbp: DecInput;
  returned: { quantity: DecInput; net: DecInput; vat: DecInput; cost: DecInput };
}

export interface ReturnRequestLine {
  line: ReturnableLine;
  quantity: DecInput;
  disposition: Disposition;
}

export interface PlannedReturnLine {
  invoiceLineId: string;
  description: string;
  quantity: Dec;
  net: Dec;
  vat: Dec;
  vatCode: VatCode;
  account: string;
  cost: Dec;
  disposition: Disposition;
}

export interface PlannedCharge {
  invoiceLineId?: string;
  description: string;
  net: Dec;
  vat: Dec;
  vatCode: VatCode;
  account: string;
}

export interface ReturnPlan {
  lines: PlannedReturnLine[];
  /** Original delivery charge refunded (when the whole order is cancelled). */
  shipping: PlannedCharge[];
  /** Deduction for diminished value, kept by the brand. */
  deduction?: PlannedCharge;
  /** What the shopper gets back. */
  refund: Dec;
}

export class ReturnError extends Error {}

/**
 * Work out a return: each line is credited pro rata to the quantity returned. The last units of a
 * line take whatever is left, so credits on a line can never add up to more (or less) than it was
 * invoiced for. Cost comes back at the cost the goods left at.
 *
 * Under the Consumer Contracts Regulations 2013 the refund includes the original standard delivery
 * charge when the whole order is cancelled, and the trader may deduct for diminished value caused
 * by handling beyond what was needed to inspect the goods.
 */
export function planReturn(input: {
  lines: ReturnRequestLine[];
  shipping?: ReturnableLine[];
  deductionGross?: DecInput;
}): ReturnPlan {
  if (!input.lines.length) throw new ReturnError("Choose at least one item to return");
  const lines: PlannedReturnLine[] = input.lines.map(({ line, quantity, disposition }) => {
    const q = d(quantity);
    const total = d(line.quantity);
    const already = d(line.returned.quantity);
    const remaining = total.minus(already);
    if (!q.isPositive() || q.isZero()) throw new ReturnError("Return quantities must be positive");
    if (q.greaterThan(remaining)) {
      throw new ReturnError(`Only ${remaining.toString()} of "${line.description}" can still be returned`);
    }
    const last = q.equals(remaining);
    const share = (whole: DecInput, done: DecInput) =>
      last ? d(whole).minus(done) : round2(d(whole).times(q).dividedBy(total));
    return {
      invoiceLineId: line.id, description: line.description, quantity: q,
      net: share(line.net, line.returned.net), vat: share(line.vat, line.returned.vat),
      vatCode: line.vatCode, account: line.account, cost: share(line.costGbp, line.returned.cost), disposition,
    };
  });
  const shipping: PlannedCharge[] = (input.shipping ?? []).map((s) => {
    if (!d(s.returned.net).isZero()) throw new ReturnError("Delivery on this order has already been refunded");
    return { invoiceLineId: s.id, description: s.description, net: d(s.net), vat: d(s.vat), vatCode: s.vatCode, account: s.account };
  });
  const credited = sum([...lines, ...shipping].map((l) => l.net.plus(l.vat)));
  let deduction: PlannedCharge | undefined;
  const gross = d(input.deductionGross ?? 0);
  if (gross.isNegative()) throw new ReturnError("A deduction cannot be negative");
  if (!gross.isZero()) {
    if (gross.greaterThanOrEqualTo(credited)) throw new ReturnError("The deduction must be less than the refund");
    const first = lines[0]!;
    const def = vatCodeDef(first.vatCode);
    const rate = d(def.selfAccounted ? 0 : def.rate);
    const vat = round2(gross.times(rate).dividedBy(rate.plus(1)));
    deduction = {
      description: "Deduction for diminished value", net: round2(gross).minus(vat), vat,
      vatCode: first.vatCode, account: first.account,
    };
  }
  return { lines, shipping, deduction, refund: credited.minus(round2(gross)) };
}

/** Consumer Contracts Regulations 2013, reg. 34: refund within 14 days of getting the goods back. */
export function refundDueBy(receivedDate: string): string {
  const dt = new Date(`${receivedDate}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + 14);
  return dt.toISOString().slice(0, 10);
}

/**
 * A return as one balanced journal (a credit note plus the stock effect):
 *   Dr Sales / Dr VAT output        for the goods and delivery credited
 *   Cr Sales / Cr VAT output        for any diminished-value deduction kept
 *   Cr Trade debtors                the refund (settled when the channel pays it out)
 *   Dr Stock, Cr Cost of sales      restocked items, at the cost they left at
 *   Dr Returns written off, Cr Cost of sales   written-off items: the sale is reversed,
 *                                   so their cost moves out of cost of sales into a loss
 */
export function postReturn(acc: RoleMap, accounts: EcomAccounts, input: { date: string; reference: string; plan: ReturnPlan }): Posting {
  const { plan } = input;
  const lines: JournalLine[] = [];
  const vat: VatEntry[] = [];
  const credit = (c: PlannedCharge) => {
    lines.push(dr(c.account, c.net, c.description));
    lines.push(dr(acc.vat_output, c.vat));
    vat.push({ direction: "sales", code: c.vatCode, net: c.net.neg(), vat: c.vat.neg() });
  };
  for (const l of plan.lines) {
    credit(l);
    if (!l.cost.isZero()) {
      lines.push(dr(l.disposition === "restock" ? acc.stock : accounts.returnsWrittenOff, l.cost, l.description));
      lines.push(cr(acc.cogs, l.cost, l.description));
    }
  }
  plan.shipping.forEach(credit);
  if (plan.deduction) {
    const x = plan.deduction;
    lines.push(cr(x.account, x.net, x.description));
    lines.push(cr(acc.vat_output, x.vat));
    vat.push({ direction: "sales", code: x.vatCode, net: x.net, vat: x.vat });
  }
  lines.push(cr(acc.debtors, plan.refund));
  // Merge VAT entries per code so the return carries one figure per rate.
  const merged = new Map<VatCode, VatEntry>();
  for (const v of vat) {
    const prev = merged.get(v.code);
    merged.set(v.code, prev ? { ...prev, net: prev.net.plus(v.net), vat: prev.vat.plus(v.vat) } : v);
  }
  return {
    journal: finalise({ date: input.date, memo: `Customer return ${input.reference}`, lines }),
    vat: [...merged.values()].filter((v) => !v.net.isZero() || !v.vat.isZero()),
  };
}
