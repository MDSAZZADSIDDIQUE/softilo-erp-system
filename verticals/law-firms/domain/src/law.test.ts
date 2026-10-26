import { d, isBalanced, sum } from "@softilo/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ClientLedgerOverdrawnError, checkTransfer, maxTransfer, nextReconciliationDue, postClientPayment, postClientReceipt,
  postClientToOffice, postFeeNote, threeWayReconciliation, timeUnits, timeValue, TransferNotAllowedError, withdrawClientMoney,
  type LawAccounts,
} from "./index.js";

const ACC: LawAccounts = { clientBank: "1250", clientControl: "2300", officeBank: "1200", debtors: "1100", fees: "4010", vatOutput: "2200" };
const pence = fc.integer({ min: 1, max: 100_000_000 }).map((p) => (p / 100).toFixed(2));

describe("time recording", () => {
  it("rounds minutes up to six-minute units", () => {
    expect(timeUnits(1)).toBe(1);
    expect(timeUnits(6)).toBe(1);
    expect(timeUnits(7)).toBe(2);
    expect(timeUnits(60)).toBe(10);
  });

  it("values time at units × rate ÷ 10, to the penny", () => {
    expect(timeValue(60, "250").toFixed(2)).toBe("250.00");
    expect(timeValue(13, "245").toFixed(2)).toBe("73.50");
    expect(timeValue(5, "333.33").toFixed(2)).toBe("33.33");
  });

  it("refuses zero, fractional or day-long entries", () => {
    expect(() => timeUnits(0)).toThrow();
    expect(() => timeUnits(1.5)).toThrow();
    expect(() => timeUnits(24 * 60 + 1)).toThrow();
    expect(() => timeValue(6, "-1")).toThrow();
  });
});

describe("client money guards", () => {
  it("allows a withdrawal up to the balance held", () => {
    expect(withdrawClientMoney("500.00", "500.00").toFixed(2)).toBe("0.00");
  });

  it("refuses to overdraw a matter's client ledger", () => {
    expect(() => withdrawClientMoney("500.00", "500.01")).toThrow(ClientLedgerOverdrawnError);
    expect(() => withdrawClientMoney("0", "0.01")).toThrow(ClientLedgerOverdrawnError);
    expect(() => withdrawClientMoney("33142", "40000")).toThrow("£33,142.00 is held and £40,000.00 was requested");
  });

  it("refuses zero or negative amounts", () => {
    expect(() => withdrawClientMoney("10", "0")).toThrow(RangeError);
    expect(() => withdrawClientMoney("10", "-5")).toThrow(RangeError);
  });

  it("never lets any sequence of receipts and guarded payments go below zero", () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.boolean(), pence), { maxLength: 40 }), (ops) => {
      let balance = d(0);
      for (const [isReceipt, amount] of ops) {
        if (isReceipt) balance = balance.plus(amount);
        else {
          try { balance = withdrawClientMoney(balance, amount); } catch (e) { expect(e).toBeInstanceOf(ClientLedgerOverdrawnError); }
        }
        expect(balance.isNegative()).toBe(false);
      }
    }));
  });

  it("limits a transfer to what is billed and what is held", () => {
    expect(checkTransfer({ clientBalance: "1000", feeNoteOutstanding: "600", amount: "600" }).toFixed(2)).toBe("600.00");
    expect(() => checkTransfer({ clientBalance: "1000", feeNoteOutstanding: "600", amount: "600.01" })).toThrow(TransferNotAllowedError);
    expect(() => checkTransfer({ clientBalance: "100", feeNoteOutstanding: "600", amount: "100.01" })).toThrow(ClientLedgerOverdrawnError);
    expect(maxTransfer("100", "600").toFixed(2)).toBe("100.00");
    expect(maxTransfer("1000", "600").toFixed(2)).toBe("600.00");
    expect(maxTransfer("0", "600").toFixed(2)).toBe("0.00");
  });
});

describe("posting rules", () => {
  it("posts client receipts and payments between client bank and client money held", () => {
    const r = postClientReceipt(ACC, { date: "2026-10-01", matter: "MAT-00001", reference: "Deposit", amount: "25000" });
    expect(r.journal.lines).toEqual([
      expect.objectContaining({ account: "1250", debit: d("25000.00") }),
      expect.objectContaining({ account: "2300", credit: d("25000.00") }),
    ]);
    const p = postClientPayment(ACC, { date: "2026-10-02", matter: "MAT-00001", reference: "SDLT", amount: "4500" });
    expect(p.journal.lines.find((l) => l.account === "2300")!.debit.toFixed(2)).toBe("4500.00");
    expect(p.journal.lines.find((l) => l.account === "1250")!.credit.toFixed(2)).toBe("4500.00");
    expect(r.vat).toEqual([]);
  });

  it("bills profit costs with VAT on the total", () => {
    const f = postFeeNote(ACC, { date: "2026-10-03", number: "FN-00001", matter: "MAT-00001", vatCode: "S20",
      lines: [{ net: "73.50" }, { net: "250.00" }, { net: "33.33" }] });
    expect(f.net.toFixed(2)).toBe("356.83");
    expect(f.vatAmount.toFixed(2)).toBe("71.37");
    expect(f.total.toFixed(2)).toBe("428.20");
    expect(f.vat).toEqual([{ direction: "sales", code: "S20", net: d("356.83"), vat: d("71.37") }]);
    expect(f.journal.lines.find((l) => l.account === "1100")!.debit.toFixed(2)).toBe("428.20");
    expect(() => postFeeNote(ACC, { date: "2026-10-03", number: "FN", matter: "M", vatCode: "S20", lines: [] })).toThrow();
  });

  it("transfers client to office in one balanced entry touching both sides", () => {
    const t = postClientToOffice(ACC, { date: "2026-10-04", matter: "MAT-00001", feeNote: "FN-00001", amount: "428.20" });
    const by = Object.fromEntries(t.journal.lines.map((l) => [l.account, l.debit.minus(l.credit).toFixed(2)]));
    expect(by).toEqual({ "2300": "428.20", "1250": "-428.20", "1200": "428.20", "1100": "-428.20" });
  });

  it("always produces balanced journals", () => {
    fc.assert(fc.property(pence, fc.array(pence, { minLength: 1, maxLength: 10 }), (amount, fees) => {
      const postings = [
        postClientReceipt(ACC, { date: "2026-10-01", matter: "M", reference: "r", amount }),
        postClientPayment(ACC, { date: "2026-10-01", matter: "M", reference: "p", amount }),
        postClientToOffice(ACC, { date: "2026-10-01", matter: "M", feeNote: "F", amount }),
        postFeeNote(ACC, { date: "2026-10-01", number: "F", matter: "M", vatCode: "S20", lines: fees.map((net) => ({ net })) }),
      ];
      for (const p of postings) expect(isBalanced(p.journal.lines)).toBe(true);
      const f = postings[3] as ReturnType<typeof postFeeNote>;
      expect(f.total.equals(sum(fees).plus(f.vatAmount))).toBe(true);
    }));
  });
});

describe("three-way reconciliation", () => {
  const base = {
    statementBalance: "20500.00",
    outstandingLodgements: ["1000.00"],
    unpresentedPayments: ["500.00"],
    cashBook: "21000.00",
    clientControl: "21000.00",
    matterBalances: [{ matterId: "a", balance: "20000.00" }, { matterId: "b", balance: "1000.00" }],
  };

  it("balances when bank, cash book and client ledgers agree", () => {
    const r = threeWayReconciliation(base);
    expect(r.adjustedBank.toFixed(2)).toBe("21000.00");
    expect(r.clientLedgers.toFixed(2)).toBe("21000.00");
    expect(r.balanced).toBe(true);
  });

  it("reports each difference", () => {
    const r = threeWayReconciliation({ ...base, statementBalance: "20499.99" });
    expect(r.balanced).toBe(false);
    expect(r.differences.bankVsCashBook.toFixed(2)).toBe("-0.01");
    expect(r.differences.cashBookVsLedgers.toFixed(2)).toBe("0.00");
  });

  it("fails if any matter is overdrawn, even when totals agree", () => {
    const r = threeWayReconciliation({ ...base, matterBalances: [{ matterId: "a", balance: "21100.00" }, { matterId: "b", balance: "-100.00" }] });
    expect(r.differences.cashBookVsLedgers.isZero()).toBe(true);
    expect(r.overdrawn).toEqual([{ matterId: "b", balance: d("-100.00") }]);
    expect(r.balanced).toBe(false);
  });

  it("checks the ledgers against client money held", () => {
    expect(threeWayReconciliation({ ...base, clientControl: "20999.00" }).differences.ledgersVsControl.toFixed(2)).toBe("1.00");
  });

  it("is due again five weeks after the statement date", () => {
    expect(nextReconciliationDue("2026-10-31")).toBe("2026-12-05");
    expect(() => nextReconciliationDue("nope")).toThrow();
  });
});
