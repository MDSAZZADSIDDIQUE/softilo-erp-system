import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  allocateLandedCosts, buildVatReturn, d, EMPTY_POSITION, finalise, InsufficientStockError, issue,
  isBalanced, lineVat, postGoodsReceipt, postLandedCost, postPayment, postPva, postSalesInvoice,
  postSupplierBill, postVatSettlement, receive, revalue, roleMap, splitPence, sum, UnbalancedJournalError,
  type VatCode,
} from "./index.js";

const acc = roleMap();
const amount = fc.integer({ min: 1, max: 10_000_000 }).map((p) => (p / 100).toFixed(2));
const vatCodeArb = fc.constantFrom<VatCode>("S20", "R5", "Z0", "EX", "OS", "RC20");

describe("VAT", () => {
  it("rounds line VAT half-up to the penny", () => {
    expect(lineVat("10.025", "S20").toFixed(2)).toBe("2.01");
    expect(lineVat("0.125", "S20").toFixed(2)).toBe("0.03");
    expect(lineVat("100", "R5").toFixed(2)).toBe("5.00");
    expect(lineVat("100", "Z0").toFixed(2)).toBe("0.00");
  });

  it("builds a 9-box return including reverse charge and postponed import VAT", () => {
    const r = buildVatReturn([
      { direction: "sales", code: "S20", net: d(1000), vat: d(200) },
      { direction: "sales", code: "Z0", net: d(500.75), vat: d(0) },
      { direction: "purchase", code: "S20", net: d(300), vat: d(60) },
      { direction: "purchase", code: "PVA20", net: d(2000), vat: d(400) },
      { direction: "purchase", code: "RC20", net: d(100), vat: d(20) },
      { direction: "purchase", code: "OS", net: d(9999), vat: d(0) },
    ]);
    expect(r).toEqual({
      box1: "620.00", box2: "0.00", box3: "620.00", box4: "480.00", box5: "140.00",
      box6: "1500", box7: "2400", box8: "0", box9: "0",
    });
  });

  it("reports box 5 as a positive amount when a refund is due", () => {
    const r = buildVatReturn([{ direction: "purchase", code: "S20", net: d(100), vat: d(20) }]);
    expect(r.box3).toBe("0.00");
    expect(r.box5).toBe("20.00");
  });
});

describe("journals", () => {
  it("rejects unbalanced journals", () => {
    expect(() => finalise({ date: "2026-01-01", memo: "x", lines: [
      { account: "1200", debit: d(10), credit: d(0) },
      { account: "4000", debit: d(0), credit: d(9.99) },
    ] })).toThrow(UnbalancedJournalError);
  });

  it("merges lines on the same account and drops zero lines", () => {
    const j = finalise({ date: "2026-01-01", memo: "x", lines: [
      { account: "1200", debit: d(10), credit: d(0) },
      { account: "1200", debit: d(0), credit: d(4) },
      { account: "4000", debit: d(0), credit: d(6) },
      { account: "5000", debit: d(0), credit: d(0) },
    ] });
    expect(j.lines).toHaveLength(2);
    expect(j.lines[0]!.debit.toFixed(2)).toBe("6.00");
  });
});

describe("posting rules", () => {
  it("goods receipt then bill at a higher price posts the variance", () => {
    const grn = postGoodsReceipt(acc, { date: "2026-01-02", reference: "GRN-1", lines: [{ valueGbp: "1000" }] });
    expect(isBalanced(grn.journal.lines)).toBe(true);
    const bill = postSupplierBill(acc, { date: "2026-01-05", reference: "B1", rate: 1, lines: [
      { kind: "receipt", net: "1010", vatCode: "S20", grniValueGbp: "1000" },
    ] });
    const byAcc = Object.fromEntries(bill.journal.lines.map((l) => [l.account, l.debit.minus(l.credit).toFixed(2)]));
    expect(byAcc).toEqual({ "2105": "1000.00", "5100": "10.00", "2201": "202.00", "2100": "-1212.00" });
    expect(bill.totalGbp.toFixed(2)).toBe("1212.00");
  });

  it("reverse-charge bill is not owed to the supplier", () => {
    const bill = postSupplierBill(acc, { date: "2026-01-05", reference: "B2", rate: 1, lines: [
      { kind: "account", net: "500", vatCode: "RC20", account: "7500" },
    ] });
    expect(bill.totalGbp.toFixed(2)).toBe("500.00");
    expect(buildVatReturn(bill.vat).box1).toBe("100.00");
    expect(buildVatReturn(bill.vat).box4).toBe("100.00");
  });

  it("foreign-currency payment books realised FX", () => {
    // Invoice for $1,000 at 0.80 = £800; customer pays $1,000 when the rate is 0.78 = £780.
    const p = postPayment(acc, { date: "2026-02-01", reference: "R1", direction: "receipt", bankAccount: "1200",
      amount: "1000", rate: "0.78", allocations: [{ amount: "1000", documentRate: "0.80" }] });
    const byAcc = Object.fromEntries(p.journal.lines.map((l) => [l.account, l.debit.minus(l.credit).toFixed(2)]));
    expect(byAcc).toEqual({ "1200": "780.00", "1100": "-800.00", "8000": "20.00" });
  });

  it("refuses allocations larger than the payment", () => {
    expect(() => postPayment(acc, { date: "2026-02-01", reference: "R", direction: "receipt", bankAccount: "1200",
      amount: "10", rate: 1, allocations: [{ amount: "11", documentRate: 1 }] })).toThrow();
  });

  it("postponed VAT nets to zero in the ledger but appears on the return", () => {
    const p = postPva(acc, { date: "2026-03-01", reference: "PVA-03", valueGbp: "5000", vatGbp: "1000" });
    expect(isBalanced(p.journal.lines)).toBe(true);
    expect(buildVatReturn(p.vat)).toMatchObject({ box1: "1000.00", box4: "1000.00", box5: "0.00", box7: "5000" });
  });

  it("VAT settlement leaves the net liability", () => {
    const s = postVatSettlement(acc, "2026-03-31", "2026-Q1", "620", "480");
    const byAcc = Object.fromEntries(s.journal.lines.map((l) => [l.account, l.debit.minus(l.credit).toFixed(2)]));
    expect(byAcc).toEqual({ "2200": "620.00", "2201": "-480.00", "2202": "-140.00" });
  });

  it("every sales invoice and bill balances (property)", () => {
    fc.assert(fc.property(
      fc.array(fc.record({ net: amount, vatCode: vatCodeArb, cost: amount }), { minLength: 1, maxLength: 8 }),
      fc.constantFrom("1", "0.79", "1.17", "0.0061"),
      fc.constantFrom<1 | -1>(1, -1),
      (lines, rate, sign) => {
        const inv = postSalesInvoice(acc, { date: "2026-01-01", reference: "I", rate, sign,
          lines: lines.map((l) => ({ net: l.net, vatCode: l.vatCode, costGbp: l.cost })) });
        const bill = postSupplierBill(acc, { date: "2026-01-01", reference: "B", rate, sign,
          lines: lines.map((l) => ({ kind: "receipt" as const, net: l.net, vatCode: l.vatCode, grniValueGbp: l.cost })) });
        return isBalanced(inv.journal.lines) && isBalanced(bill.journal.lines);
      },
    ));
  });
});

describe("landed cost", () => {
  it("allocates exactly to the penny by value", () => {
    const a = allocateLandedCosts(
      [{ id: "a", quantity: 1, value: 1 }, { id: "b", quantity: 1, value: 1 }, { id: "c", quantity: 1, value: 1 }],
      [{ id: "freight", amount: "100", method: "value" }],
    );
    expect(a.map((x) => x.amount.toFixed(2))).toEqual(["33.34", "33.33", "33.33"]);
  });

  it("supports weight, volume and quantity bases", () => {
    const lines = [
      { id: "a", quantity: 10, value: 100, weight: 30, volume: 1 },
      { id: "b", quantity: 30, value: 900, weight: 10, volume: 3 },
    ];
    const by = (method: "weight" | "volume" | "quantity") =>
      allocateLandedCosts(lines, [{ id: "x", amount: "400", method }]).map((x) => x.amount.toFixed(2));
    expect(by("weight")).toEqual(["300.00", "100.00"]);
    expect(by("volume")).toEqual(["100.00", "300.00"]);
    expect(by("quantity")).toEqual(["100.00", "300.00"]);
  });

  it("always sums to the cost line total (property)", () => {
    fc.assert(fc.property(
      fc.integer({ min: -10_000_000, max: 10_000_000 }),
      fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 40 }).filter((w) => w.some((x) => x > 0)),
      (pence, weights) => {
        const parts = splitPence(d(pence).dividedBy(100), weights);
        return sum(parts).equals(d(pence).dividedBy(100)) && parts.every((p) => p.decimalPlaces() <= 2);
      },
    ));
  });

  it("refuses an all-zero basis", () => {
    expect(() => splitPence(10, [0, 0])).toThrow();
  });

  it("posts the share on sold stock to cost of sales", () => {
    const p = postLandedCost(acc, { date: "2026-01-10", reference: "SHP-1", stockGbp: "75", cogsGbp: "25" });
    const byAcc = Object.fromEntries(p.journal.lines.map((l) => [l.account, l.debit.minus(l.credit).toFixed(2)]));
    expect(byAcc).toEqual({ "1001": "75.00", "5000": "25.00", "2110": "-100.00" });
  });
});

describe("weighted average costing", () => {
  it("averages receipts and issues at average cost", () => {
    let p = receive(EMPTY_POSITION, 10, "100");
    p = receive(p, 10, "200");
    const out = issue(p, 5);
    expect(out.cost.toFixed(2)).toBe("75.00");
    expect(out.position.value.toFixed(2)).toBe("225.00");
  });

  it("issuing everything on hand takes the full value", () => {
    const p = receive(EMPTY_POSITION, 3, "10");
    const a = issue(p, 1);
    const b = issue(a.position, 1);
    const c = issue(b.position, 1);
    expect([a.cost, b.cost, c.cost].map((x) => x.toFixed(2))).toEqual(["3.33", "3.34", "3.33"]);
    expect(c.position.value.isZero()).toBe(true);
  });

  it("revalues stock on hand", () => {
    expect(revalue(receive(EMPTY_POSITION, 4, "40"), "8").value.toFixed(2)).toBe("48.00");
  });

  it("refuses to issue more than on hand", () => {
    expect(() => issue(receive(EMPTY_POSITION, 1, "1"), 2)).toThrow(InsufficientStockError);
  });

  it("never leaves value without quantity (property)", () => {
    fc.assert(fc.property(
      fc.array(fc.tuple(fc.integer({ min: 1, max: 1000 }), amount), { minLength: 1, maxLength: 10 }),
      fc.array(fc.integer({ min: 1, max: 500 }), { maxLength: 20 }),
      (receipts, issues) => {
        let p = EMPTY_POSITION;
        for (const [q, v] of receipts) p = receive(p, q, v);
        for (const q of issues) if (p.quantity.gte(q)) p = issue(p, q).position;
        p = p.quantity.isZero() ? p : issue(p, p.quantity).position;
        return p.value.isZero();
      },
    ));
  });
});

describe("bank entries", () => {
  it("extracts VAT from a gross bank payment", async () => {
    const { postBankEntry } = await import("./index.js");
    const p = postBankEntry(acc, { date: "2026-01-01", reference: "BT", bankAccount: "1200", gross: "-120", account: "7500", vatCode: "S20" });
    const byAcc = Object.fromEntries(p.journal.lines.map((l) => [l.account, l.debit.minus(l.credit).toFixed(2)]));
    expect(byAcc).toEqual({ "1200": "-120.00", "7500": "100.00", "2201": "20.00" });
    expect(buildVatReturn(p.vat)).toMatchObject({ box4: "20.00", box7: "100" });
  });

  it("codes money in to income with output VAT", async () => {
    const { postBankEntry } = await import("./index.js");
    const p = postBankEntry(acc, { date: "2026-01-01", reference: "BT", bankAccount: "1200", gross: "10.00", account: "4900", vatCode: "S20" });
    const byAcc = Object.fromEntries(p.journal.lines.map((l) => [l.account, l.debit.minus(l.credit).toFixed(2)]));
    expect(byAcc).toEqual({ "1200": "10.00", "4900": "-8.33", "2200": "-1.67" });
  });
});
