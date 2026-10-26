import { d, sum } from "@softilo/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addDays, allocateFefo, allowedActions, BATCH_STATUSES, BatchTransitionError, checkSupplyEligibility, expiryBand,
  InsufficientReleasedStockError, isInDate, isSellable, normaliseExpiry, transitionBatch,
  type BatchStock, type CustomerLicence,
} from "./index.js";

describe("expiry", () => {
  it("treats a month-only expiry as the last day of that month", () => {
    expect(normaliseExpiry("2027-03")).toBe("2027-03-31");
    expect(normaliseExpiry("2028-02")).toBe("2028-02-29");
    expect(normaliseExpiry("2027-02")).toBe("2027-02-28");
    expect(normaliseExpiry(" 2027-11-15 ")).toBe("2027-11-15");
  });

  it("rejects impossible dates", () => {
    expect(() => normaliseExpiry("2027-13")).toThrow();
    expect(() => normaliseExpiry("2027-02-30")).toThrow();
    expect(() => normaliseExpiry("03/2027")).toThrow();
  });

  it("allows supply up to and including the expiry date, less the minimum shelf life", () => {
    expect(isInDate("2026-11-30", "2026-11-30")).toBe(true);
    expect(isInDate("2026-11-30", "2026-12-01")).toBe(false);
    expect(isInDate("2027-01-29", "2026-10-31", 90)).toBe(true);
    expect(isInDate("2027-01-28", "2026-10-31", 90)).toBe(false);
  });

  it("buckets expiry for the dashboard", () => {
    expect(expiryBand("2026-10-25", "2026-10-26")).toBe("expired");
    expect(expiryBand("2026-11-20", "2026-10-26")).toBe("30");
    expect(expiryBand("2027-01-10", "2026-10-26")).toBe("90");
    expect(expiryBand("2027-04-10", "2026-10-26")).toBe("180");
    expect(expiryBand("2028-01-01", "2026-10-26")).toBe("ok");
  });
});

describe("batch status", () => {
  const base = { expiry: "2028-01-31", onDate: "2026-10-26", actorIsRp: true };

  it("lets a Responsible Person release quarantined stock", () => {
    expect(transitionBatch({ ...base, from: "quarantine", action: "release" })).toBe("released");
  });

  it("refuses status changes by anyone who is not an RP", () => {
    expect(() => transitionBatch({ ...base, actorIsRp: false, from: "quarantine", action: "release" })).toThrow(/Responsible Person/);
  });

  it("needs a reason to reject, recall or re-quarantine", () => {
    expect(() => transitionBatch({ ...base, from: "quarantine", action: "reject" })).toThrow(/reason/);
    expect(() => transitionBatch({ ...base, from: "released", action: "recall", reason: "  " })).toThrow(/reason/);
    expect(transitionBatch({ ...base, from: "released", action: "recall", reason: "MHRA class 2 drug alert" })).toBe("recalled");
    expect(transitionBatch({ ...base, from: "released", action: "quarantine", reason: "Temperature excursion" })).toBe("quarantine");
  });

  it("never releases expired stock", () => {
    expect(() => transitionBatch({ ...base, expiry: "2026-10-25", from: "quarantine", action: "release" })).toThrow(/expired/);
  });

  it("treats recalled as final and rejected as never sellable", () => {
    expect(allowedActions("recalled")).toEqual([]);
    expect(allowedActions("rejected")).toEqual(["recall"]);
    expect(() => transitionBatch({ ...base, from: "rejected", action: "release" })).toThrow(BatchTransitionError);
    expect(() => transitionBatch({ ...base, from: "recalled", action: "release" })).toThrow(BatchTransitionError);
  });

  it("only ever reaches 'released' through an RP release from quarantine", () => {
    for (const from of BATCH_STATUSES) {
      for (const action of allowedActions(from)) {
        const to = transitionBatch({ ...base, from, action, reason: "x" });
        if (to === "released") expect([from, action]).toEqual(["quarantine", "release"]);
      }
    }
  });
});

describe("FEFO allocation", () => {
  const batch = (id: string, expiry: string, onHand: string, status: BatchStock["status"] = "released", receivedOn = "2026-01-01"): BatchStock =>
    ({ id, batchNumber: id.toUpperCase(), expiry, onHand, status, receivedOn });
  const opts = { onDate: "2026-10-26" };

  it("takes the earliest expiry first and splits across batches", () => {
    const a = allocateFefo([batch("b", "2027-06-30", "50"), batch("a", "2027-03-31", "30"), batch("c", "2028-01-31", "100")], 60, opts);
    expect(a.map((x) => [x.batchId, x.quantity.toString()])).toEqual([["a", "30"], ["b", "30"]]);
  });

  it("skips quarantined, rejected, recalled, expired and short-dated batches", () => {
    const batches = [
      batch("q", "2027-01-31", "10", "quarantine"),
      batch("r", "2027-01-31", "10", "rejected"),
      batch("x", "2027-01-31", "10", "recalled"),
      batch("e", "2026-10-25", "10"),
      batch("s", "2026-12-31", "10"),
      batch("g", "2027-09-30", "10"),
    ];
    const a = allocateFefo(batches, 10, { ...opts, minShelfLifeDays: 90 });
    expect(a.map((x) => x.batchId)).toEqual(["g"]);
    try {
      allocateFefo(batches, 11, { ...opts, minShelfLifeDays: 90 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InsufficientReleasedStockError);
      const err = e as InsufficientReleasedStockError;
      expect(err.sellable.toString()).toBe("10");
      expect(err.unsellable.quarantine.toString()).toBe("10");
      expect(err.unsellable.blocked.toString()).toBe("20");
      expect(err.unsellable.expired.toString()).toBe("10");
      expect(err.unsellable.shortDated.toString()).toBe("10");
      expect(err.message).toMatch(/Only 10 released, in-date units available; 11 requested/);
    }
  });

  it("breaks expiry ties by receipt date, then batch number", () => {
    const a = allocateFefo([
      batch("late", "2027-06-30", "5", "released", "2026-05-01"),
      batch("early", "2027-06-30", "5", "released", "2026-04-01"),
    ], 6, opts);
    expect(a.map((x) => x.batchId)).toEqual(["early", "late"]);
  });

  it("handles fractional quantities without floating-point drift", () => {
    const a = allocateFefo([batch("a", "2027-01-31", "0.1"), batch("b", "2027-02-28", "0.2")], "0.3", opts);
    expect(sum(a.map((x) => x.quantity)).toString()).toBe("0.3");
  });

  const statusArb = fc.constantFrom<BatchStock["status"]>("quarantine", "released", "rejected", "recalled");
  const batchesArb = fc.array(fc.record({
    expiryOffset: fc.integer({ min: -30, max: 900 }),
    onHand: fc.integer({ min: 0, max: 500 }),
    status: statusArb,
    receivedOffset: fc.integer({ min: 0, max: 300 }),
  }), { minLength: 1, maxLength: 12 }).map((rows) => rows.map((r, i) => batch(
    `b${i}`, addDays(opts.onDate, r.expiryOffset), String(r.onHand), r.status, addDays("2025-01-01", r.receivedOffset))));

  it("always allocates exactly the quantity, only from sellable batches, earliest expiry first", () => {
    fc.assert(fc.property(batchesArb, fc.integer({ min: 1, max: 2000 }), fc.integer({ min: 0, max: 180 }), (batches, qty, minDays) => {
      const o = { ...opts, minShelfLifeDays: minDays };
      const sellable = sum(batches.filter((b) => isSellable(b, o)).map((b) => b.onHand));
      if (sellable.lessThan(qty)) {
        expect(() => allocateFefo(batches, qty, o)).toThrow(InsufficientReleasedStockError);
        return;
      }
      const a = allocateFefo(batches, qty, o);
      expect(sum(a.map((x) => x.quantity)).equals(qty)).toBe(true);
      const byId = new Map(batches.map((b) => [b.id, b]));
      for (const x of a) {
        const b = byId.get(x.batchId)!;
        expect(isSellable(b, o)).toBe(true);
        expect(x.quantity.lessThanOrEqualTo(b.onHand)).toBe(true);
      }
      // FEFO: any sellable batch expiring before the latest allocated one is used up in full.
      const latest = a[a.length - 1]!.expiry;
      for (const b of batches.filter((b) => isSellable(b, o) && b.expiry < latest)) {
        const used = a.find((x) => x.batchId === b.id);
        expect(used?.quantity.equals(d(b.onHand))).toBe(true);
      }
    }));
  });
});

describe("customer eligibility", () => {
  const onDate = "2026-10-26";
  const pharmacy: CustomerLicence = { type: "gphc_pharmacy", number: "1234567", status: "active", verifiedOn: "2026-09-01", expiresOn: null };
  const pom = { kind: "medicine" as const, legalCategory: "POM" as const };

  it("supplies devices and GSL medicines without a licence", () => {
    expect(checkSupplyEligibility({ kind: "device" }, [], { onDate })).toMatchObject({ ok: true, requiresLicence: false });
    expect(checkSupplyEligibility({ kind: "medicine", legalCategory: "GSL" }, [], { onDate })).toMatchObject({ ok: true });
  });

  it("needs a verified, in-date entitlement for POM and P medicines", () => {
    expect(checkSupplyEligibility(pom, [], { onDate })).toMatchObject({ ok: false, reason: expect.stringMatching(/no licence/) });
    expect(checkSupplyEligibility(pom, [pharmacy], { onDate })).toMatchObject({ ok: true, requiresLicence: true });
    expect(checkSupplyEligibility(pom, [{ ...pharmacy, verifiedOn: null }], { onDate }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/not been verified/) });
    expect(checkSupplyEligibility(pom, [{ ...pharmacy, expiresOn: "2026-10-25" }], { onDate }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/expired on 2026-10-25/) });
    expect(checkSupplyEligibility(pom, [{ ...pharmacy, status: "suspended" }], { onDate }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/suspended/) });
    expect(checkSupplyEligibility(pom, [{ ...pharmacy, verifiedOn: "2025-09-01" }], { onDate }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/re-checking/) });
  });

  it("does not accept a CD licence alone for ordinary medicines", () => {
    const cd: CustomerLicence = { type: "home_office_cd", number: "HO-1", status: "active", verifiedOn: "2026-09-01" };
    expect(checkSupplyEligibility(pom, [cd], { onDate }).ok).toBe(false);
  });

  it("needs a CD entitlement for Schedule 2 and 3 drugs, and refuses Schedule 1", () => {
    const wholesaler: CustomerLicence = { type: "wda_h", number: "WDA(H) 12345", status: "active", verifiedOn: "2026-10-01" };
    const cd2 = { ...pom, cdSchedule: 2 };
    expect(checkSupplyEligibility(cd2, [wholesaler], { onDate }).ok).toBe(false);
    expect(checkSupplyEligibility(cd2, [wholesaler, { ...wholesaler, type: "home_office_cd", number: "HO-9" }], { onDate }).ok).toBe(true);
    expect(checkSupplyEligibility(cd2, [pharmacy], { onDate }).ok).toBe(true);
    expect(checkSupplyEligibility({ ...pom, cdSchedule: 4 }, [wholesaler], { onDate }).ok).toBe(true);
    expect(checkSupplyEligibility({ ...pom, cdSchedule: 1 }, [pharmacy], { onDate }).ok).toBe(false);
  });
});
