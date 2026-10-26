import { d, isBalanced, roleMap, sum } from "@softilo/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BomCycleError, completionCost, conversionCost, explodeRequirements, findBomCycle, lowLevelCodes, mfgRoleMap,
  postCompletion, postConversion, postMaterialIssue, requiredQuantity, rollUpCost, runMrp, type Bom, type BomMap,
} from "./index.js";

const acc = roleMap();
const mfg = mfgRoleMap();

/** Lamp (made in 1s) ← 1 shade + 1 base (sub-assembly, made in 10s) ← 4 screws (5% wastage) + 0.5 kg steel. */
const lamp: Bom = {
  productId: "LAMP", outputQty: 1,
  lines: [{ componentId: "SHADE", quantity: 1 }, { componentId: "BASE", quantity: 1 }],
  operations: [{ workCentreId: "ASSY", setupHours: 0, runHoursPerUnit: "0.25" }],
};
const base: Bom = {
  productId: "BASE", outputQty: 10,
  lines: [{ componentId: "SCREW", quantity: 40, wastagePct: 5 }, { componentId: "STEEL", quantity: 5 }],
  operations: [{ workCentreId: "FAB", setupHours: 1, runHoursPerUnit: "0.1" }],
};
const boms: BomMap = new Map([["LAMP", lamp], ["BASE", base]]);
const rates = new Map([
  ["ASSY", { labourRate: "18.00", overheadRate: "12.00" }],
  ["FAB", { labourRate: "20.00", overheadRate: "30.00" }],
]);

describe("bills of materials", () => {
  it("calculates requirements per order with wastage, rounding up", () => {
    expect(requiredQuantity(25, 10, { quantity: 40, wastagePct: 5 }).toString()).toBe("105");
    expect(requiredQuantity(1, 3, { quantity: 1 }).toFixed(4)).toBe("0.3334");
    const req = explodeRequirements({ productId: "X", outputQty: 1, lines: [{ componentId: "A", quantity: 2 }, { componentId: "A", quantity: 1 }] }, 4);
    expect(req.map((r) => [r.productId, r.quantity.toString()])).toEqual([["A", "12"]]);
  });

  it("detects a BOM that contains itself, at any depth", () => {
    expect(findBomCycle(boms)).toBeNull();
    const cyclic: BomMap = new Map(boms);
    cyclic.set("SCREW", { productId: "SCREW", outputQty: 1, lines: [{ componentId: "LAMP", quantity: 1 }] });
    expect(findBomCycle(cyclic)).toEqual(["LAMP", "BASE", "SCREW", "LAMP"]);
    expect(() => lowLevelCodes(cyclic)).toThrow(BomCycleError);
  });

  it("assigns low-level codes by deepest use", () => {
    const llc = lowLevelCodes(new Map([...boms, ["KIT", { productId: "KIT", outputQty: 1, lines: [{ componentId: "SCREW", quantity: 1 }] }]]));
    expect(Object.fromEntries(llc)).toEqual({ LAMP: 0, KIT: 0, SHADE: 1, BASE: 1, SCREW: 2, STEEL: 2 });
  });

  it("rolls up material, labour and overhead through every level", () => {
    const bought = new Map([["SHADE", "6.50"], ["SCREW", "0.02"], ["STEEL", "3.00"]]);
    const base1 = rollUpCost("BASE", boms, bought, rates);
    // Material per base: (40 × 1.05 × 0.02 + 5 × 3) ÷ 10 = 1.584. Hours per base: 1 ÷ 10 + 0.1 = 0.2.
    expect([base1.material, base1.labour, base1.overhead, base1.total].map((x) => x.toFixed(6)))
      .toEqual(["1.584000", "4.000000", "6.000000", "11.584000"]);
    const r = rollUpCost("LAMP", boms, bought, rates);
    // Lamp: shade 6.50 + base 11.584 = 18.084 material; 0.25 h × 18 / × 12.
    expect([r.material, r.labour, r.overhead, r.total].map((x) => x.toFixed(6)))
      .toEqual(["18.084000", "4.500000", "3.000000", "25.584000"]);
    expect(r.components.find((c) => c.productId === "BASE")).toMatchObject({ made: true });
    expect(r.missingCosts).toEqual([]);
    expect(rollUpCost("LAMP", boms, new Map([["SHADE", 1]]), rates).missingCosts.sort()).toEqual(["SCREW", "STEEL"]);
  });
});

describe("works-order postings", () => {
  it("issues materials Stock → WIP and absorbs conversion at standard rates", () => {
    const issue = postMaterialIssue(acc, mfg, { date: "2026-10-01", reference: "WO-00001", lines: [{ costGbp: "65.00" }, { costGbp: "12.34" }] });
    expect(issue.journal.lines).toEqual([
      expect.objectContaining({ account: "1002", debit: d("77.34") }),
      expect.objectContaining({ account: "1001", credit: d("77.34") }),
    ]);
    const conv = conversionCost("2.5", { labourRate: "18.333", overheadRate: "12" });
    expect([conv.labour.toFixed(2), conv.overhead.toFixed(2)]).toEqual(["45.83", "30.00"]);
    const posting = postConversion(mfg, { date: "2026-10-01", reference: "WO-00001", labourGbp: conv.labour, overheadGbp: conv.overhead });
    expect(isBalanced(posting.journal.lines)).toBe(true);
    expect(posting.journal.lines.find((l) => l.account === "5400")?.credit.toFixed(2)).toBe("45.83");
    expect(posting.journal.lines.find((l) => l.account === "5410")?.credit.toFixed(2)).toBe("30.00");
  });

  it("takes WIP in proportion to units on a part completion and clears it on the final one", () => {
    const part = completionCost({ wip: "100.00", remaining: 3, good: 1, scrap: 0, final: false });
    expect([part.good, part.scrap, part.wipAfter].map((x) => x.toFixed(2))).toEqual(["33.33", "0.00", "66.67"]);
    const last = completionCost({ wip: part.wipAfter, remaining: 2, good: 1, scrap: 1, final: true });
    expect([last.good, last.scrap, last.variance, last.wipAfter].map((x) => x.toFixed(2))).toEqual(["33.34", "33.33", "0.00", "0.00"]);
    const close = completionCost({ wip: "4.20", remaining: 0, good: 0, scrap: 0, final: true });
    expect(close.variance.toFixed(2)).toBe("4.20");
    expect(() => completionCost({ wip: "1", remaining: 1, good: 0, scrap: 0, final: false })).toThrow();
    const posting = postCompletion(acc, mfg, { date: "2026-10-02", reference: "WO-00001", cost: last });
    expect(posting.journal.lines.map((l) => [l.account, l.debit.toFixed(2), l.credit.toFixed(2)])).toEqual([
      ["1001", "33.34", "0.00"], ["5300", "33.33", "0.00"], ["1002", "0.00", "66.67"],
    ]);
  });

  it("never strands or invents WIP: completions over an order always add up to what went in", () => {
    const pence = fc.integer({ min: 0, max: 10_000_000 }).map((p) => (p / 100).toFixed(2));
    fc.assert(fc.property(pence, fc.array(fc.tuple(fc.integer({ min: 0, max: 20 }), fc.integer({ min: 0, max: 5 })), { minLength: 1, maxLength: 8 }),
      (wipIn, steps) => {
        const qty = steps.reduce((s, [g, x]) => s + g + x, 0) + 1;
        let wip = d(wipIn);
        let remaining = d(qty);
        const out = [];
        for (const [g, x] of steps) {
          if (g + x === 0) continue;
          const c = completionCost({ wip, remaining, good: g, scrap: x, final: false });
          const posting = postCompletionSafe(c);
          if (posting) expect(isBalanced(posting.journal.lines)).toBe(true);
          out.push(c.good, c.scrap);
          expect(c.wipAfter.isNegative()).toBe(false);
          wip = c.wipAfter;
          remaining = remaining.minus(g + x);
        }
        const fin = completionCost({ wip, remaining, good: 1, scrap: 0, final: true });
        out.push(fin.good, fin.scrap, fin.variance);
        expect(fin.wipAfter.isZero()).toBe(true);
        expect(sum(out).toFixed(2)).toBe(d(wipIn).toFixed(2));
      }));
  });
});

/** A completion of zero value has no journal to post (finalise refuses an empty journal). */
function postCompletionSafe(c: ReturnType<typeof completionCost>) {
  if (c.good.isZero() && c.scrap.isZero() && c.variance.isZero()) return null;
  return postCompletion(acc, mfg, { date: "2026-10-02", reference: "WO", cost: c });
}

describe("MRP", () => {
  it("nets level by level and explodes short sub-assemblies into their components", () => {
    const rows = runMrp({
      boms,
      // An open order for 30 lamps that has issued nothing yet.
      demand: [{ productId: "SHADE", quantity: 30 }, { productId: "BASE", quantity: 30 }],
      onHand: new Map([["SHADE", 10], ["BASE", 5], ["SCREW", 50], ["STEEL", 100]]),
      onOrder: new Map([["SHADE", 15]]),
      inProduction: new Map([["BASE", 5]]),
    });
    const byId = Object.fromEntries(rows.map((r) => [r.productId, [r.level, r.demand.toString(), r.shortage.toString(), r.action]]));
    expect(byId).toEqual({
      SHADE: [1, "30", "5", "buy"],
      BASE: [1, "30", "20", "make"],
      // 20 bases → 20 ÷ 10 × 40 × 1.05 = 84 screws, 10 kg steel.
      SCREW: [2, "84", "34", "buy"],
      STEEL: [2, "10", "0", null],
    });
  });
});
