import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { d, isBalanced, roleMap, sum, type JournalDraft } from "@softilo/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ECOM_ACCOUNTS } from "./accounts.js";
import { adapterFor } from "./adapters/registry.js";
import { ChannelFormatError, type ChannelOrder, type ChannelPayout } from "./channels.js";
import { checkLineVat, orderToSaleLines, postChannelSale, VatMismatchError } from "./orders.js";
import { amountsByOrder, PayoutMismatchError, postPayoutClearing, splitPayout } from "./payouts.js";
import { planReturn, postReturn, refundDueBy, ReturnError, type ReturnableLine } from "./returns.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "shopify");
const load = (name: string) => JSON.parse(readFileSync(join(fixtures, name), "utf8")) as unknown;
const acc = roleMap();
const shopify = adapterFor("shopify");

const bal = (j: JournalDraft, account: string) =>
  sum(j.lines.filter((l) => l.account === account).map((l) => l.debit.minus(l.credit))).toFixed(2);

describe("Shopify adapter", () => {
  const orders = shopify.parseOrders(load("orders-2026-09.json"));

  it("reads orders, discounts, tax and delivery", () => {
    expect(orders).toHaveLength(5);
    const o = orders[0]!;
    expect(o).toMatchObject({ externalId: "6001000001", orderNumber: "#1001", date: "2026-09-02", currency: "GBP", pricesIncludeTax: true, shipCountry: "GB" });
    expect(o.customer.name).toBe("Amelia Jones");
    expect(o.lines[0]).toMatchObject({ sku: "CANDLE-FIG", quantity: "2", gross: "39.60", tax: "6.60", taxRate: "0.2" });
    expect(o.shipping[0]).toMatchObject({ gross: "3.99", tax: "0.67" });
  });

  it("refuses money sent as numbers", () => {
    const bad = { orders: [{ ...(load("orders-2026-09.json") as { orders: object[] }).orders[1], total_price: 18 }] };
    expect(() => shopify.parseOrders(bad)).toThrow(ChannelFormatError);
  });

  it("refuses files that are not Shopify orders", () => {
    expect(() => shopify.parseOrders({ hello: 1 })).toThrow(/not a Shopify orders file/);
  });

  it("reads a Shopify Payments payout into charges, fees, refunds and reserves", () => {
    const p = shopify.parsePayout(load("payout-2026-09-08.json"));
    expect(p).toMatchObject({ externalId: "88001", date: "2026-09-08", amount: "76.32" });
    expect(p.lines.filter((l) => l.kind === "order")).toHaveLength(3);
    expect(p.lines.filter((l) => l.kind === "fee").map((l) => l.amount)).toEqual(["-0.90", "-0.52", "-0.85"]);
    expect(amountsByOrder(p, "refund").get("6001000002")!.toFixed(2)).toBe("18.00");
  });

  it("only Shopify is available so far", () => {
    expect(() => adapterFor("amazon")).toThrow(/not available yet/);
  });
});

describe("orders to sales invoices", () => {
  const orders = shopify.parseOrders(load("orders-2026-09.json"));

  it("splits tax-inclusive lines into net and VAT, keeping the channel's VAT", () => {
    const lines = orderToSaleLines(orders[0]!);
    expect(lines.map((l) => [l.kind, l.net.toFixed(2), l.vat.toFixed(2), l.vatCode])).toEqual([
      ["goods", "33.00", "6.60", "S20"],
      // 3.99 includes 0.67 VAT; 3.32 × 20% would be 0.66: the 1p rounding difference is allowed.
      ["shipping", "3.32", "0.67", "S20"],
    ]);
  });

  it("drops zero-value delivery lines", () => {
    expect(orderToSaleLines(orders[2]!).map((l) => l.kind)).toEqual(["goods", "goods"]);
  });

  it("posts a balanced invoice whose total is what the shopper paid", () => {
    const lines = orderToSaleLines(orders[0]!);
    const p = postChannelSale(acc, {
      date: "2026-09-02", reference: "#1001",
      lines: lines.map((l) => ({ net: l.net, vat: l.vat, vatCode: l.vatCode, account: l.kind === "goods" ? acc.sales : "4900", costGbp: l.kind === "goods" ? "16.00" : undefined })),
    });
    expect(p.total.toFixed(2)).toBe("43.59");
    expect(isBalanced(p.journal.lines)).toBe(true);
    expect(bal(p.journal, acc.debtors)).toBe("43.59");
    expect(bal(p.journal, acc.vat_output)).toBe("-7.27");
    expect(bal(p.journal, acc.cogs)).toBe("16.00");
    expect(bal(p.journal, acc.stock)).toBe("-16.00");
  });

  it("refuses VAT that doesn't match the code", () => {
    expect(() => checkLineVat("10.00", "2.02", "S20")).toThrow(VatMismatchError);
    expect(() => checkLineVat("10.00", "0.01", "Z0")).toThrow(VatMismatchError);
    expect(() => checkLineVat("10.00", "2.01", "S20")).not.toThrow();
  });

  it("treats marketplace-collected VAT as outside the brand's return", () => {
    const o: ChannelOrder = { ...orders[1]!, vatTreatment: "marketplace" };
    expect(orderToSaleLines(o).map((l) => [l.net.toFixed(2), l.vat.toFixed(2), l.vatCode])).toEqual([["15.00", "0.00", "OS"]]);
  });

  it("refuses an export that charged VAT", () => {
    expect(() => orderToSaleLines({ ...orders[1]!, vatTreatment: "export" })).toThrow(/export/);
  });

  it("refuses an order whose lines don't add up to its total", () => {
    expect(() => orderToSaleLines({ ...orders[1]!, total: "18.01" })).toThrow(/order total/);
  });

  it("always balances, for any tax-inclusive price at 20%", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 10_000_000 }), fc.integer({ min: 1, max: 50 }), (pence, qty) => {
      const gross = d(pence).dividedBy(100).times(qty);
      const tax = gross.dividedBy(6).toDecimalPlaces(2);
      const order: ChannelOrder = {
        ...orders[1]!, total: gross.toFixed(2),
        lines: [{ externalId: "1", sku: "X", title: "X", quantity: String(qty), gross: gross.toFixed(2), tax: tax.toFixed(2), taxRate: "0.2" }],
      };
      const lines = orderToSaleLines(order);
      const p = postChannelSale(acc, { date: "2026-09-01", reference: "x", lines: lines.map((l) => ({ ...l, account: acc.sales })) });
      return isBalanced(p.journal.lines) && p.total.equals(gross);
    }));
  });
});

describe("payout reconciliation", () => {
  const payout = shopify.parsePayout(load("payout-2026-09-08.json"));
  const accounts = { ...ECOM_ACCOUNTS };

  it("splits a payout and reconciles it to the bank amount", () => {
    const s = splitPayout(payout, "RC20");
    expect([s.sales, s.refunds, s.feesGross, s.feesNet, s.feesVat, s.reserves].map((v) => v.toFixed(2)))
      .toEqual(["101.59", "18.00", "2.27", "2.27", "0.45", "-5.00"]);
    expect(s.reconciled).toBe(true);
  });

  it("posts a balanced clearing journal with reverse-charged fees", () => {
    const p = postPayoutClearing(acc, { date: payout.date, reference: "88001", bankAccount: "1200", split: splitPayout(payout, "RC20"), accounts });
    expect(isBalanced(p.journal.lines)).toBe(true);
    expect(bal(p.journal, "1200")).toBe("76.32");
    expect(bal(p.journal, acc.debtors)).toBe("-83.59");
    expect(bal(p.journal, accounts.fees)).toBe("2.27");
    expect(bal(p.journal, accounts.reserves)).toBe("5.00");
    expect(bal(p.journal, acc.vat_input)).toBe("0.45");
    expect(bal(p.journal, acc.vat_output)).toBe("-0.45");
    expect(p.vat).toEqual([expect.objectContaining({ direction: "purchase", code: "RC20" })]);
  });

  it("extracts UK VAT from fees charged with VAT", () => {
    const s = splitPayout(payout, "S20");
    expect([s.feesNet.toFixed(2), s.feesVat.toFixed(2)]).toEqual(["1.89", "0.38"]);
    const p = postPayoutClearing(acc, { date: payout.date, reference: "x", bankAccount: "1200", split: s, accounts });
    expect(bal(p.journal, acc.vat_output)).toBe("0.00");
    expect(isBalanced(p.journal.lines)).toBe(true);
  });

  it("refuses a payout that doesn't add up", () => {
    const bad: ChannelPayout = { ...payout, amount: "76.33" };
    expect(splitPayout(bad, "EX").difference.toFixed(2)).toBe("0.01");
    expect(() => postPayoutClearing(acc, { date: bad.date, reference: "x", bankAccount: "1200", split: splitPayout(bad, "EX"), accounts }))
      .toThrow(PayoutMismatchError);
  });

  it("balances for any mix of sales, refunds, fees, reserves and adjustments", () => {
    const amt = fc.integer({ min: 0, max: 1_000_000 }).map((p) => d(p).dividedBy(100));
    fc.assert(fc.property(fc.array(amt, { maxLength: 8 }), fc.array(amt, { maxLength: 4 }), fc.array(amt, { maxLength: 8 }),
      fc.integer({ min: -100_000, max: 100_000 }), fc.constantFrom("S20", "RC20", "EX", "OS" as const), (sales, refunds, fees, reservePence, code) => {
        const lines: ChannelPayout["lines"] = [
          ...sales.map((a, i) => ({ kind: "order" as const, orderRef: String(i), amount: a.toFixed(2), description: "" })),
          ...refunds.map((a, i) => ({ kind: "refund" as const, orderRef: String(i), amount: a.neg().toFixed(2), description: "" })),
          ...fees.map((a) => ({ kind: "fee" as const, amount: a.neg().toFixed(2), description: "" })),
          { kind: "reserve" as const, amount: d(reservePence).dividedBy(100).toFixed(2), description: "" },
        ];
        const amount = sum(lines.map((l) => d(l.amount)));
        if (amount.isZero() && lines.every((l) => d(l.amount).isZero())) return true;
        const split = splitPayout({ ...payout, amount: amount.toFixed(2), lines }, code);
        if (!split.reconciled) return false;
        try {
          return isBalanced(postPayoutClearing(acc, { date: "2026-09-08", reference: "x", bankAccount: "1200", split, accounts }).journal.lines);
        } catch (e) {
          return (e as Error).message === "Journal has no non-zero lines";
        }
      }));
  });
});

describe("returns", () => {
  const line = (over: Partial<ReturnableLine> = {}): ReturnableLine => ({
    id: "l1", description: "Fig & cedar candle", quantity: "3", net: "50.00", vat: "10.00", vatCode: "S20",
    account: acc.sales, costGbp: "24.00", returned: { quantity: "0", net: "0", vat: "0", cost: "0" }, ...over,
  });
  const accounts = { ...ECOM_ACCOUNTS };

  it("credits pro rata and the last unit takes the remainder", () => {
    const first = planReturn({ lines: [{ line: line(), quantity: "1", disposition: "restock" }] });
    expect([first.lines[0]!.net, first.lines[0]!.vat, first.lines[0]!.cost].map((v) => v.toFixed(2))).toEqual(["16.67", "3.33", "8.00"]);
    const rest = planReturn({
      lines: [{ line: line({ returned: { quantity: "1", net: "16.67", vat: "3.33", cost: "8.00" } }), quantity: "2", disposition: "restock" }],
    });
    expect([rest.lines[0]!.net, rest.lines[0]!.vat, rest.lines[0]!.cost].map((v) => v.toFixed(2))).toEqual(["33.33", "6.67", "16.00"]);
  });

  it("refuses returning more than was sold", () => {
    expect(() => planReturn({ lines: [{ line: line({ returned: { quantity: "3", net: "50", vat: "10", cost: "24" } }), quantity: "1", disposition: "restock" }] }))
      .toThrow(ReturnError);
  });

  it("restocks at original cost and refunds through debtors", () => {
    const plan = planReturn({ lines: [{ line: line(), quantity: "3", disposition: "restock" }] });
    const p = postReturn(acc, accounts, { date: "2026-09-06", reference: "RMA-1", plan });
    expect(isBalanced(p.journal.lines)).toBe(true);
    expect(bal(p.journal, acc.debtors)).toBe("-60.00");
    expect(bal(p.journal, acc.stock)).toBe("24.00");
    expect(bal(p.journal, acc.cogs)).toBe("-24.00");
    expect(p.vat).toEqual([expect.objectContaining({ direction: "sales", code: "S20" })]);
    expect(p.vat[0]!.vat.toFixed(2)).toBe("-10.00");
  });

  it("writes off damaged items: cost moves from cost of sales to returns written off", () => {
    const plan = planReturn({ lines: [{ line: line(), quantity: "1", disposition: "write_off" }] });
    const p = postReturn(acc, accounts, { date: "2026-09-06", reference: "RMA-2", plan });
    expect(bal(p.journal, accounts.returnsWrittenOff)).toBe("8.00");
    expect(bal(p.journal, acc.cogs)).toBe("-8.00");
    expect(bal(p.journal, acc.stock)).toBe("0.00");
  });

  it("refunds delivery and keeps a diminished-value deduction", () => {
    const shipping = line({ id: "s1", description: "Delivery", quantity: "1", net: "3.32", vat: "0.67", costGbp: "0", account: "4900" });
    const plan = planReturn({ lines: [{ line: line(), quantity: "3", disposition: "restock" }], shipping: [shipping], deductionGross: "6.00" });
    expect(plan.refund.toFixed(2)).toBe("57.99");
    expect([plan.deduction!.net.toFixed(2), plan.deduction!.vat.toFixed(2)]).toEqual(["5.00", "1.00"]);
    const p = postReturn(acc, accounts, { date: "2026-09-06", reference: "RMA-3", plan });
    expect(isBalanced(p.journal.lines)).toBe(true);
    expect(bal(p.journal, acc.vat_output)).toBe("9.67");
  });

  it("refuses a deduction as large as the refund", () => {
    expect(() => planReturn({ lines: [{ line: line(), quantity: "1", disposition: "restock" }], deductionGross: "20.00" })).toThrow(/less than the refund/);
  });

  it("works out the refund deadline under the Consumer Contracts Regulations", () => {
    expect(refundDueBy("2026-09-06")).toBe("2026-09-20");
    expect(refundDueBy("2026-12-25")).toBe("2027-01-08");
  });
});
