import fc from "fast-check";
import { d, isBalanced, roleMap, sum } from "@softilo/domain";
import { describe, expect, it } from "vitest";
import {
  buildCis300, cisDeduction, cisPaymentShare, constructionSalesVat, jobCostSummary, paymentTimetable,
  postApplication, postJobBill, taxMonthEnding, taxMonthOf, valueApplication,
} from "./index.js";

const acc = roleMap();

describe("CIS deductions", () => {
  it("deducts at 0%, 20% and 30%, rounding down to the penny", () => {
    expect(cisDeduction("1000", "gross").toFixed(2)).toBe("0.00");
    expect(cisDeduction("1000", "net").toFixed(2)).toBe("200.00");
    expect(cisDeduction("333.33", "unmatched").toFixed(2)).toBe("99.99");
    expect(cisDeduction("0.07", "net").toFixed(2)).toBe("0.01");
  });

  it("deducts on labour only and posts a balanced journal to the CIS liability", () => {
    const p = postJobBill(acc, "2211", {
      date: "2026-10-10", reference: "SUB-1", cisStatus: "net",
      lines: [
        { category: "labour", net: "2000", vatCode: "RC20", account: "5300" },
        { category: "materials", net: "500", vatCode: "RC20", account: "5310" },
      ],
    });
    expect(p.cis).toMatchObject({ gross: d(2500), materials: d(500), liable: d(2000), rate: "0.20" });
    expect(p.cis!.deduction.toFixed(2)).toBe("400.00");
    // Reverse charge: no VAT owed to the subcontractor, so £2,500 − £400.
    expect(p.total.toFixed(2)).toBe("2100.00");
    expect(isBalanced(p.journal.lines)).toBe(true);
    const line = (a: string) => p.journal.lines.find((l) => l.account === a)!;
    expect(line("2211").credit.toFixed(2)).toBe("400.00");
    expect(line(acc.creditors).credit.toFixed(2)).toBe("2100.00");
  });

  it("leaves a merchant's bill untouched", () => {
    const p = postJobBill(acc, "2211", { date: "2026-10-10", reference: "M-1", lines: [{ category: "materials", net: "100", vatCode: "S20", account: "5310" }] });
    expect(p.cis).toBeNull();
    expect(p.total.toFixed(2)).toBe("120.00");
  });

  it("always balances", () => {
    const amt = fc.integer({ min: 0, max: 5_000_000 }).map((v) => (v / 100).toFixed(2));
    fc.assert(fc.property(amt, amt, fc.constantFrom("gross", "net", "unmatched" as const), fc.constantFrom("S20", "RC20", "OS" as const), (lab, mat, st, vat) => {
      if (Number(lab) + Number(mat) === 0) return;
      const p = postJobBill(acc, "2211", { date: "2026-10-10", reference: "X", cisStatus: st, lines: [
        { category: "labour", net: lab, vatCode: vat, account: "5300" }, { category: "materials", net: mat, vatCode: vat, account: "5310" }] });
      expect(isBalanced(p.journal.lines)).toBe(true);
    }));
  });

  it("splits a bill paid in instalments so the parts add up to the penny", () => {
    const amt = fc.integer({ min: 1, max: 1_000_000 });
    fc.assert(fc.property(amt, fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 6 }), (pence, weights) => {
      const payable = d(pence).dividedBy(100);
      const bill = { payable, gross: payable.times("1.3").toDecimalPlaces(2), materials: payable.times("0.4").toDecimalPlaces(2), deduction: payable.times("0.3").toDecimalPlaces(2) };
      const total = weights.reduce((a, b) => a + b, 0);
      const parts: number[] = weights.map((w) => Math.floor((pence * w) / total));
      parts[parts.length - 1]! += pence - parts.reduce((a, b) => a + b, 0);
      let before = d(0);
      const shares = parts.map((p) => { const s = cisPaymentShare(bill, before, d(p).dividedBy(100)); before = before.plus(d(p).dividedBy(100)); return s; });
      expect(sum(shares.map((s) => s.deduction)).equals(bill.deduction)).toBe(true);
      expect(sum(shares.map((s) => s.gross)).equals(bill.gross)).toBe(true);
    }));
  });
});

describe("CIS tax months and the CIS300", () => {
  it("runs from the 6th to the 5th with deadlines on the 19th and 22nd", () => {
    expect(taxMonthEnding("2026-11-05")).toMatchObject({ start: "2026-10-06", taxYear: "2026-27", number: 7, returnDue: "2026-11-19", paymentDue: "2026-11-22", statementsDue: "2026-11-19" });
    expect(taxMonthEnding("2027-01-05").start).toBe("2026-12-06");
    expect(taxMonthEnding("2027-04-05")).toMatchObject({ taxYear: "2026-27", number: 12 });
    expect(taxMonthOf("2026-10-05").end).toBe("2026-10-05");
    expect(taxMonthOf("2026-12-06").end).toBe("2027-01-05");
  });

  it("reports payments in the month they were made", () => {
    const month = taxMonthEnding("2026-11-05");
    const subs = [{ id: "s1", name: "Ace Brickwork", utr: "1234567890", status: "unmatched" as const, verificationNumber: "V1234567890A" }];
    const bill = { billId: "b1", billNumber: "BILL-1", supplierRef: "A1", subcontractorId: "s1", payable: "700", gross: "1000", materials: "0", deduction: "300",
      payments: [{ date: "2026-10-20", sequence: "1", amount: "350" }, { date: "2026-11-10", sequence: "2", amount: "350" }] };
    const r = buildCis300(month, subs, [bill]);
    expect(r.totals).toMatchObject({ grossPaid: "500.00", amountDeducted: "150.00", subcontractors: 1 });
    expect(r.statements[0]!.verificationNumber).toBe("V1234567890A");
    expect(buildCis300(taxMonthEnding("2027-01-05"), subs, [bill]).nil).toBe(true);
  });
});

describe("domestic reverse charge", () => {
  const base = { supplierVatRegistered: true, customerVatRegistered: true, customerCisRegistered: true, endUserOrIntermediary: false, rate: "standard" as const };
  it("applies between VAT and CIS registered businesses", () => {
    expect(constructionSalesVat(base)).toMatchObject({ code: "RC20", reverseCharge: true });
  });
  it("is excluded for end users, zero-rated work and the 5% disregard", () => {
    expect(constructionSalesVat({ ...base, endUserOrIntermediary: true }).code).toBe("S20");
    expect(constructionSalesVat({ ...base, rate: "zero" }).code).toBe("Z0");
    expect(constructionSalesVat({ ...base, fivePercentDisregard: true }).code).toBe("S20");
    expect(constructionSalesVat({ ...base, customerCisRegistered: false }).code).toBe("S20");
  });
});

describe("applications for payment", () => {
  it("holds back retention and releases half at practical completion", () => {
    const v1 = valueApplication({ grossToDate: "100000", contractRetentionRate: "0.05", stage: "interim" });
    expect([v1.retentionToDate.toFixed(2), v1.amountDue.toFixed(2)]).toEqual(["5000.00", "95000.00"]);
    const v2 = valueApplication({ grossToDate: "100000", contractRetentionRate: "0.05", stage: "practical_completion", previous: v1 });
    expect([v2.retentionMovement.toFixed(2), v2.amountDue.toFixed(2)]).toEqual(["-2500.00", "2500.00"]);
    expect(() => valueApplication({ grossToDate: "90000", contractRetentionRate: "0.05", stage: "interim", previous: v1 })).toThrow();
  });

  it("posts revenue for the full value and retention to its own account", () => {
    const v = valueApplication({ grossToDate: "10000", contractRetentionRate: "0.03", stage: "interim" });
    const p = postApplication(acc, "1105", { date: "2026-10-31", reference: "AFP-1", valuation: v, vatCode: "S20" });
    expect(isBalanced(p.journal.lines)).toBe(true);
    expect(p.total.toFixed(2)).toBe("11640.00");
    const sales = p.journal.lines.filter((l) => l.account === acc.sales);
    expect(sum(sales.map((l) => l.credit)).toFixed(2)).toBe("10000.00");
    const rc = postApplication(acc, "1105", { date: "2026-10-31", reference: "AFP-2", valuation: v, vatCode: "RC20" });
    expect(rc.total.toFixed(2)).toBe("9700.00");
  });

  it("works out the Scheme payment timetable", () => {
    expect(paymentTimetable("2026-10-31", "2026-10-31")).toEqual({ dueDate: "2026-11-07", finalDate: "2026-11-24", paymentNoticeBy: "2026-11-12", payLessNoticeBy: "2026-11-17" });
  });
});

describe("job costing", () => {
  it("compares budget with actual and works out margin", () => {
    const s = jobCostSummary({ contractSum: "100000", variations: ["5000"], valuedToDate: "40000",
      budget: [{ category: "labour", amount: "50000" }, { category: "materials", amount: "30000" }],
      costs: [{ category: "labour", amount: "20000" }, { category: "materials", amount: "12000" }] });
    expect(s).toMatchObject({ contractValue: "105000.00", costToDate: "32000.00", marginToDate: "8000.00", budgetedMargin: "25000.00" });
    expect(s.categories[0]).toMatchObject({ category: "labour", remaining: "30000.00", usedPercent: "40.0" });
  });
});
