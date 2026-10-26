import { d, sum } from "@softilo/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  allocateFefo, batchStatus, checkManualAllocation, daysBetween, expiryFrom, fefoOrder, InsufficientBatchStockError,
  summariseTrace, type BatchStock,
} from "./index.js";

const batch = (id: string, expiry: string | null, available: string, dateType: BatchStock["dateType"] = "use_by", receivedOn?: string): BatchStock =>
  ({ id, code: id.toUpperCase(), expiry, dateType, available, receivedOn });

describe("dates", () => {
  it("counts whole days across month and leap-year boundaries", () => {
    expect(daysBetween("2026-10-26", "2026-10-26")).toBe(0);
    expect(daysBetween("2026-10-26", "2026-11-02")).toBe(7);
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2); // across the clocks going forward
    expect(daysBetween("2026-11-02", "2026-10-26")).toBe(-7);
  });

  it("works out a date mark from shelf life", () => {
    expect(expiryFrom("2026-10-26", 10)).toBe("2026-11-05");
    expect(expiryFrom("2026-12-30", 3)).toBe("2027-01-02");
    expect(() => expiryFrom("2026-10-26", -1)).toThrow();
  });

  it("classifies use-by and best-before batches", () => {
    const today = "2026-10-26";
    expect(batchStatus({ expiry: "2026-10-25", dateType: "use_by" }, today)).toBe("expired");
    expect(batchStatus({ expiry: "2026-10-26", dateType: "use_by" }, today)).toBe("expiring");
    expect(batchStatus({ expiry: "2026-10-25", dateType: "best_before" }, today)).toBe("past_best_before");
    expect(batchStatus({ expiry: "2026-11-30", dateType: "use_by" }, today)).toBe("ok");
    expect(batchStatus({ expiry: "2026-11-01", dateType: "use_by" }, today, 3)).toBe("ok");
    expect(batchStatus({ expiry: null, dateType: "best_before" }, today)).toBe("no_date");
  });
});

describe("FEFO allocation", () => {
  const today = "2026-10-26";

  it("takes the earliest date first and splits across batches", () => {
    const r = allocateFefo([batch("c", "2026-11-20", "50"), batch("a", "2026-11-01", "10"), batch("b", "2026-11-10", "30")], "25", { today });
    expect(r.map((x) => [x.batchId, x.quantity.toString()])).toEqual([["a", "10"], ["b", "15"]]);
  });

  it("never allocates a batch past its use-by date", () => {
    const r = allocateFefo([batch("old", "2026-10-25", "100"), batch("new", "2026-11-05", "100")], "40", { today });
    expect(r.map((x) => x.batchId)).toEqual(["new"]);
    expect(() => allocateFefo([batch("old", "2026-10-25", "100")], "1", { today }))
      .toThrow(/use-by/);
  });

  it("supplies best-before stock past its date but flags it", () => {
    const r = allocateFefo([batch("bb", "2026-10-01", "5", "best_before"), batch("ok", "2027-01-01", "5", "best_before")], "6", { today });
    expect(r.map((x) => [x.batchId, x.pastBestBefore])).toEqual([["bb", true], ["ok", false]]);
  });

  it("respects the customer's minimum remaining life", () => {
    const batches = [batch("short", "2026-10-30", "10"), batch("long", "2026-11-30", "10")];
    expect(allocateFefo(batches, "5", { today, minLifeDays: 7 }).map((x) => x.batchId)).toEqual(["long"]);
    expect(allocateFefo(batches, "5", { today }).map((x) => x.batchId)).toEqual(["short"]);
  });

  it("puts undated batches last and breaks ties by receipt date", () => {
    const ordered = fefoOrder([
      batch("nodate", null, "1", "best_before"),
      batch("later", "2026-11-01", "1", "use_by", "2026-10-10"),
      batch("earlier", "2026-11-01", "1", "use_by", "2026-10-01"),
    ]);
    expect(ordered.map((b) => b.id)).toEqual(["earlier", "later", "nodate"]);
  });

  it("reports what is short and why", () => {
    try {
      allocateFefo([batch("x", "2026-10-20", "10"), batch("y", "2026-12-01", "3")], "5", { today });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InsufficientBatchStockError);
      const err = e as InsufficientBatchStockError;
      expect(err.available.toString()).toBe("3");
      expect(err.message).toMatch(/Batch X is past its use-by date/);
    }
  });

  it("allocates exactly the quantity asked, never more than a batch holds, always in date order", () => {
    const arbBatch = fc.record({
      days: fc.integer({ min: -10, max: 60 }),
      qty: fc.integer({ min: 0, max: 5000 }),
      type: fc.constantFrom<BatchStock["dateType"]>("use_by", "best_before"),
    });
    fc.assert(fc.property(fc.array(arbBatch, { minLength: 1, maxLength: 12 }), fc.integer({ min: 1, max: 20000 }), (specs, wantedRaw) => {
      const batches = specs.map((s, i) => batch(`b${i}`, expiryFrom("2026-10-16", s.days + 10), (s.qty / 100).toFixed(2), s.type));
      const sellable = sum(batches.filter((b) => !(b.dateType === "use_by" && b.expiry! < today)).map((b) => b.available));
      const wanted = d(wantedRaw).dividedBy(100);
      if (wanted.greaterThan(sellable)) {
        expect(() => allocateFefo(batches, wanted, { today })).toThrow(InsufficientBatchStockError);
        return;
      }
      const r = allocateFefo(batches, wanted, { today });
      expect(sum(r.map((x) => x.quantity)).equals(wanted)).toBe(true);
      const byId = new Map(batches.map((b) => [b.id, b]));
      for (const a of r) {
        const b = byId.get(a.batchId)!;
        expect(a.quantity.lessThanOrEqualTo(b.available)).toBe(true);
        expect(b.dateType === "use_by" && b.expiry! < today).toBe(false);
      }
      for (let i = 1; i < r.length; i++) expect((r[i - 1]!.expiry ?? "") <= (r[i]!.expiry ?? "")).toBe(true);
    }));
  });
});

describe("manual batch choice", () => {
  const today = "2026-10-26";
  const batches = [batch("a", "2026-11-01", "10"), batch("b", "2026-12-01", "10"), batch("x", "2026-10-01", "10")];

  it("accepts a valid choice even if it is not FEFO order", () => {
    const r = checkManualAllocation(batches, [{ batchId: "b", quantity: "8" }], "8", { today });
    expect(r[0]!.batchId).toBe("b");
  });

  it("refuses expired use-by stock, over-picking and totals that do not match", () => {
    expect(() => checkManualAllocation(batches, [{ batchId: "x", quantity: "1" }], "1", { today })).toThrow(/use-by/);
    expect(() => checkManualAllocation(batches, [{ batchId: "a", quantity: "6" }, { batchId: "a", quantity: "5" }], "11", { today })).toThrow(/only 10/);
    expect(() => checkManualAllocation(batches, [{ batchId: "a", quantity: "2" }], "3", { today })).toThrow(/add up/);
    expect(() => checkManualAllocation(batches, [{ batchId: "zzz", quantity: "1" }], "1", { today })).toThrow(/does not belong/);
  });
});

describe("recall trace", () => {
  it("lists every customer supplied, with net quantities and documents", () => {
    const t = summariseTrace([
      { kind: "receipt", quantity: "100", date: "2026-10-01", contactId: "sup", contactName: "Supplier", document: "GRN-00001" },
      { kind: "dispatch", quantity: "-30", date: "2026-10-03", contactId: "c1", contactName: "Café One", document: "INV-00001" },
      { kind: "dispatch", quantity: "-10", date: "2026-10-05", contactId: "c2", contactName: "Bistro Two", document: "INV-00002" },
      { kind: "dispatch", quantity: "-5", date: "2026-10-06", contactId: "c1", contactName: "Café One", document: "INV-00003" },
      { kind: "return", quantity: "10", date: "2026-10-07", contactId: "c2", contactName: "Bistro Two", document: "CN-00001" },
      { kind: "write_off", quantity: "-15", date: "2026-10-08" },
    ]);
    expect(t.received.toString()).toBe("100");
    expect(t.dispatched.toString()).toBe("45");
    expect(t.returned.toString()).toBe("10");
    expect(t.writtenOff.toString()).toBe("15");
    expect(t.onHand.toString()).toBe("50");
    expect(t.customers.map((c) => [c.contactName, c.quantity.toString(), c.documents.join(","), c.firstDate, c.lastDate])).toEqual([
      ["Café One", "35", "INV-00001,INV-00003", "2026-10-03", "2026-10-06"],
      ["Bistro Two", "0", "INV-00002,CN-00001", "2026-10-05", "2026-10-07"],
    ]);
  });
});
