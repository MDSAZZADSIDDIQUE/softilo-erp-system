import { d, sum } from "@softilo/domain";
import {
  ChannelFormatError, type ChannelAdapter, type ChannelOrder, type ChannelPayout, type ChannelPayoutLine, type VatTreatment,
} from "../channels.js";

/**
 * Shopify adapter. Reads the Admin REST API formats as files or webhook bodies:
 * - orders: `{ "orders": [ … ] }` (or a single order object) as returned by GET /orders.json
 * - payouts: `{ "payout": { … }, "transactions": [ … ] }`: a Shopify Payments payout with its
 *   balance transactions (GET /shopify_payments/payouts/{id}.json and /balance/transactions.json?payout_id=…)
 * Shopify sends money as decimal strings; numbers are refused so nothing passes through a float.
 */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function obj(v: unknown, where: string): Obj {
  if (!isObj(v)) throw new ChannelFormatError(`${where} should be an object`);
  return v;
}

function arr(v: unknown, where: string): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ChannelFormatError(`${where} should be a list`);
  return v;
}

function str(v: unknown, where: string): string {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isInteger(v)) return String(v);
  throw new ChannelFormatError(`${where} is missing`);
}

/** Money must arrive as a decimal string, e.g. "19.99". */
function money(v: unknown, where: string): string {
  if (typeof v !== "string" || !/^-?\d+(\.\d{1,2})?$/.test(v.trim())) {
    throw new ChannelFormatError(`${where} should be an amount like "19.99"`);
  }
  return d(v.trim()).toFixed(2);
}

/** Tax rates are small fractions (0.2); Shopify sends them as JSON numbers. */
function rate(v: unknown, where: string): string {
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v)) return v;
  if (typeof v === "number" && v >= 0 && v < 1) return String(v);
  throw new ChannelFormatError(`${where} should be a tax rate like 0.2`);
}

function taxOf(lines: unknown, where: string): { tax: string; rate: string } {
  const taxLines = arr(lines, where).map((t, i) => obj(t, `${where}[${i}]`));
  const tax = sum(taxLines.map((t, i) => d(money(t.price, `${where}[${i}].price`))));
  const r = sum(taxLines.map((t, i) => d(rate(t.rate, `${where}[${i}].rate`))));
  return { tax: tax.toFixed(2), rate: r.toString() };
}

function parseOrder(raw: unknown, vatTreatment: VatTreatment): ChannelOrder {
  const o = obj(raw, "order");
  const id = str(o.id, "order.id");
  const name = typeof o.name === "string" ? o.name : `#${str(o.order_number ?? id, "order.order_number")}`;
  const where = `Order ${name}`;
  const created = str(o.processed_at ?? o.created_at, `${where} created_at`);
  if (!/^\d{4}-\d{2}-\d{2}/.test(created)) throw new ChannelFormatError(`${where}: created_at is not a date`);
  const customer = isObj(o.customer) ? o.customer : {};
  const address = isObj(o.shipping_address) ? o.shipping_address : isObj(o.billing_address) ? o.billing_address : {};
  const fullName = [customer.first_name, customer.last_name].filter((x) => typeof x === "string" && x).join(" ");

  const lines = arr(o.line_items, `${where} line_items`).map((raw, i) => {
    const l = obj(raw, `${where} line ${i + 1}`);
    const at = `${where} line ${i + 1}`;
    const quantity = l.quantity;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) {
      throw new ChannelFormatError(`${at}: quantity should be a whole number`);
    }
    const price = d(money(l.price, `${at} price`));
    // Shopify spreads order-level discounts onto lines as discount_allocations; older payloads use total_discount.
    const allocations = arr(l.discount_allocations, `${at} discount_allocations`);
    const discount = allocations.length
      ? sum(allocations.map((a, j) => d(money(obj(a, `${at} discount ${j + 1}`).amount, `${at} discount ${j + 1} amount`))))
      : d(l.total_discount === undefined ? "0" : money(l.total_discount, `${at} total_discount`));
    const { tax, rate: r } = taxOf(l.tax_lines, `${at} tax_lines`);
    return {
      externalId: str(l.id, `${at} id`),
      sku: typeof l.sku === "string" && l.sku.trim() ? l.sku.trim() : null,
      title: typeof l.title === "string" ? (typeof l.variant_title === "string" && l.variant_title ? `${l.title} – ${l.variant_title}` : l.title) : "Item",
      quantity: String(quantity),
      gross: price.times(quantity).minus(discount).toFixed(2),
      tax,
      taxRate: r,
    };
  });

  const shipping = arr(o.shipping_lines, `${where} shipping_lines`).map((raw, i) => {
    const s = obj(raw, `${where} shipping ${i + 1}`);
    const at = `${where} shipping ${i + 1}`;
    const allocations = arr(s.discount_allocations, `${at} discount_allocations`);
    const discount = sum(allocations.map((a, j) => d(money(obj(a, `${at} discount ${j + 1}`).amount, `${at} discount amount`))));
    const { tax, rate: r } = taxOf(s.tax_lines, `${at} tax_lines`);
    return {
      title: typeof s.title === "string" ? `Delivery: ${s.title}` : "Delivery",
      gross: d(money(s.price, `${at} price`)).minus(discount).toFixed(2),
      tax,
      taxRate: r,
    };
  });

  return {
    channel: "shopify",
    externalId: id,
    orderNumber: name,
    date: created.slice(0, 10),
    currency: str(o.currency, `${where} currency`).toUpperCase(),
    customer: {
      name: fullName || (typeof address.name === "string" ? address.name : "Online customer"),
      email: typeof o.email === "string" ? o.email : typeof customer.email === "string" ? customer.email : undefined,
    },
    shipCountry: typeof address.country_code === "string" ? address.country_code : undefined,
    pricesIncludeTax: o.taxes_included === true,
    financialStatus: typeof o.financial_status === "string" ? o.financial_status : "paid",
    lines,
    shipping,
    total: money(o.total_price, `${where} total_price`),
    vatTreatment,
  };
}

/** Shopify balance transaction types and how each one lands in the payout split. */
function payoutLines(raw: Obj, i: number): ChannelPayoutLine[] {
  const at = `Transaction ${i + 1}`;
  const type = str(raw.type, `${at} type`);
  const amount = money(raw.amount, `${at} amount`);
  const fee = raw.fee === undefined ? "0.00" : money(raw.fee, `${at} fee`);
  if (raw.net !== undefined && !d(money(raw.net, `${at} net`)).equals(d(amount).minus(fee))) {
    throw new ChannelFormatError(`${at}: net is not amount less fee`);
  }
  const orderRef = raw.source_order_id === undefined || raw.source_order_id === null ? undefined : str(raw.source_order_id, `${at} source_order_id`);
  const out: ChannelPayoutLine[] = [];
  switch (type) {
    case "charge":
      out.push({ kind: "order", orderRef, amount, description: "Order payment" });
      break;
    case "refund":
      out.push({ kind: "refund", orderRef, amount, description: "Refund" });
      break;
    case "reserve":
      out.push({ kind: "reserve", amount, description: d(amount).isNegative() ? "Reserve held" : "Reserve released" });
      break;
    case "adjustment":
    case "dispute":
    case "chargeback":
      out.push({ kind: "adjustment", orderRef, amount, description: type === "adjustment" ? "Adjustment" : "Chargeback" });
      break;
    case "payout":
      return [];
    default:
      throw new ChannelFormatError(`${at}: unknown transaction type "${type}"`);
  }
  if (!d(fee).isZero()) out.push({ kind: "fee", orderRef, amount: d(fee).neg().toFixed(2), description: "Shopify Payments fee" });
  return out;
}

export function shopifyAdapter(opts: { vatTreatment?: VatTreatment } = {}): ChannelAdapter {
  const treatment = opts.vatTreatment ?? "seller";
  return {
    kind: "shopify",
    parseOrders(payload) {
      if (Array.isArray(payload)) return payload.map((o) => parseOrder(o, treatment));
      const p = obj(payload, "Shopify file");
      if (Array.isArray(p.orders)) return p.orders.map((o) => parseOrder(o, treatment));
      if (isObj(p.order)) return [parseOrder(p.order, treatment)];
      if (p.line_items) return [parseOrder(p, treatment)];
      throw new ChannelFormatError("This is not a Shopify orders file (expected an \"orders\" list)");
    },
    parsePayout(payload): ChannelPayout {
      const p = obj(payload, "Shopify payout file");
      const payout = obj(p.payout, "payout");
      const date = str(payout.date, "payout.date");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ChannelFormatError("payout.date should be YYYY-MM-DD");
      const txns = arr(p.transactions, "transactions").map((t, i) => obj(t, `Transaction ${i + 1}`));
      return {
        channel: "shopify",
        externalId: str(payout.id, "payout.id"),
        date,
        currency: str(payout.currency, "payout.currency").toUpperCase(),
        amount: money(payout.amount, "payout.amount"),
        lines: txns.flatMap(payoutLines),
      };
    },
  };
}
