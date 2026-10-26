import {
  cr, d, dr, finalise, lineVat, round2, sum, vatCode as vatCodeDef, type Dec, type DecInput, type JournalLine,
  type Posting, type RoleMap, type VatCode, type VatEntry,
} from "@softilo/domain";
import { ChannelFormatError, type ChannelOrder } from "./channels.js";

/** One line of the sales invoice an order becomes: goods or delivery charged to the shopper. */
export interface SaleLine {
  kind: "goods" | "shipping";
  sku: string | null;
  description: string;
  quantity: Dec;
  net: Dec;
  vat: Dec;
  vatCode: VatCode;
}

/** UK VAT code for a channel's tax rate. Rates are compared as decimals, never as floats. */
export function vatCodeForRate(rate: DecInput): VatCode {
  const r = d(rate);
  if (r.equals("0.2")) return "S20";
  if (r.equals("0.05")) return "R5";
  if (r.isZero()) return "Z0";
  throw new ChannelFormatError(`Tax rate ${r.toString()} is not a UK VAT rate`);
}

/** Check the adapter's lines add up to the total the channel reports. */
export function checkOrderTotal(order: ChannelOrder): void {
  const lines = sum(order.lines.map((l) => d(l.gross)));
  const shipping = sum(order.shipping.map((s) => d(s.gross)));
  const tax = order.pricesIncludeTax ? d(0)
    : sum([...order.lines.map((l) => d(l.tax)), ...order.shipping.map((s) => d(s.tax))]);
  const computed = lines.plus(shipping).plus(tax);
  if (!computed.equals(d(order.total))) {
    throw new ChannelFormatError(`Order ${order.orderNumber}: lines add up to ${computed.toFixed(2)} but the order total is ${d(order.total).toFixed(2)}`);
  }
}

/**
 * Split a channel order into invoice lines: net, VAT and VAT code per line, using the tax the
 * channel actually charged so the invoice equals what the shopper paid.
 * Under the marketplace (deemed supplier) treatment the marketplace keeps the VAT, so the
 * brand's sale is the VAT-exclusive amount, outside the scope of its own UK return.
 */
export function orderToSaleLines(order: ChannelOrder): SaleLine[] {
  checkOrderTotal(order);
  const out: SaleLine[] = [];
  const add = (kind: SaleLine["kind"], sku: string | null, description: string, quantity: DecInput,
    gross: DecInput, tax: DecInput, rate: DecInput) => {
    const g = d(gross);
    const t = d(tax);
    if (g.isZero() && t.isZero()) return;
    const net = order.pricesIncludeTax ? g.minus(t) : g;
    let code: VatCode;
    let vat: Dec;
    switch (order.vatTreatment) {
      case "seller":
        code = vatCodeForRate(rate);
        vat = t;
        break;
      case "marketplace":
        code = "OS";
        vat = d(0);
        break;
      case "export":
        if (!t.isZero()) throw new ChannelFormatError(`Order ${order.orderNumber} is an export but VAT was charged`);
        code = "Z0";
        vat = d(0);
        break;
    }
    out.push({ kind, sku, description, quantity: d(quantity), net: round2(net), vat: round2(vat), vatCode: code });
  };
  for (const l of order.lines) {
    if (!d(l.quantity).isPositive() || d(l.quantity).isZero()) throw new ChannelFormatError(`Order ${order.orderNumber}: quantity must be positive`);
    add("goods", l.sku, l.title, l.quantity, l.gross, l.tax, l.taxRate);
  }
  for (const s of order.shipping) add("shipping", null, s.title, 1, s.gross, s.tax, s.taxRate);
  if (!out.length) throw new ChannelFormatError(`Order ${order.orderNumber} has no lines`);
  return out;
}

/** The VAT on a line doesn't match its code (allowing the 1p a channel's own rounding can differ by). */
export class VatMismatchError extends Error {}

/** Checks VAT charged by a channel against the VAT the code implies, within 1p. */
export function checkLineVat(net: DecInput, vat: DecInput, code: VatCode): void {
  const def = vatCodeDef(code);
  const expected = def.selfAccounted ? d(0) : lineVat(net, code);
  const diff = d(vat).minus(expected).abs();
  const tolerance = d(def.rate).isZero() || def.selfAccounted ? d(0) : d("0.01");
  if (diff.greaterThan(tolerance)) {
    throw new VatMismatchError(`VAT of ${d(vat).toFixed(2)} on ${d(net).toFixed(2)} does not match ${def.name} (expected ${expected.toFixed(2)})`);
  }
}

export interface ChannelSaleLine {
  net: DecInput;
  vat: DecInput;
  vatCode: VatCode;
  account: string;
  /** Cost of stock issued, in GBP, from the costing engine. */
  costGbp?: DecInput;
  description?: string;
}

export interface ChannelSaleInput {
  date: string;
  reference: string;
  lines: ChannelSaleLine[];
}

/**
 * A channel order as a sales invoice: Dr Debtors (the channel owes us), Cr Sales, Cr VAT output,
 * and Dr Cost of sales, Cr Stock for goods shipped. Unlike the core rule it takes the VAT the
 * channel charged (checked against the code) instead of recalculating it, so the invoice total
 * always equals the order total. GBP only.
 */
export function postChannelSale(acc: RoleMap, s: ChannelSaleInput): Posting & { total: Dec } {
  const lines: JournalLine[] = [];
  const vat: VatEntry[] = [];
  const owed: Dec[] = [];
  for (const l of s.lines) {
    const net = round2(l.net);
    const v = round2(l.vat);
    checkLineVat(net, v, l.vatCode);
    lines.push(cr(l.account, net, l.description));
    if (!v.isZero()) lines.push(cr(acc.vat_output, v));
    if (l.costGbp !== undefined && !d(l.costGbp).isZero()) {
      lines.push(dr(acc.cogs, l.costGbp, l.description));
      lines.push(cr(acc.stock, l.costGbp, l.description));
    }
    vat.push({ direction: "sales", code: l.vatCode, net, vat: v });
    owed.push(net.plus(v));
  }
  const total = sum(owed);
  lines.push(dr(acc.debtors, total));
  return { journal: finalise({ date: s.date, memo: `Channel order ${s.reference}`, lines }), vat, total };
}
