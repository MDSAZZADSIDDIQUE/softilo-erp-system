import fc from "fast-check";
import { d, isBalanced, postSalesInvoice, roleMap, sum } from "@softilo/domain";
import { describe, expect, it } from "vitest";
import {
  addDays, assessAwr, checkPlacement, checkTimesheet, canTransition, engagementDefaults, marginReport, nationalLivingWage,
  permFee, permRebate, postWorkerPayAccrual, priceTimesheet, qualifiesWithin, recAccounts, timesheetInvoiceLines, weekDays,
  type AwrInput,
} from "./index.js";

const acc = recAccounts();
const rates = [
  { rateType: "standard", payRate: "14.50", chargeRate: "19.75" },
  { rateType: "overtime", payRate: "21.75", chargeRate: "29.63" },
];

/** Every weekday from `start` for `weeks` weeks. */
function weekdays(start: string, weeks: number): string[] {
  return Array.from({ length: weeks * 7 }, (_, i) => addDays(start, i)).filter((_, i) => i % 7 < 5);
}

describe("placement compliance", () => {
  const base = { clientSize: "medium_large" as const, startDate: "2026-10-05", rates };

  it("requires a KID before a PAYE or umbrella worker starts", () => {
    expect(checkPlacement({ ...base, engagement: "paye" }).errors).toContain("Give the worker a Key Information Document before agreeing terms");
    expect(checkPlacement({ ...base, engagement: "umbrella", kidIssuedOn: "2026-10-06" }).errors)
      .toContain("The Key Information Document must be issued before the placement starts");
    expect(checkPlacement({ ...base, engagement: "paye", kidIssuedOn: "2026-10-01" }).errors).toEqual([]);
  });

  it("requires an IR35 status and, for medium and large clients, an SDS for limited-company contractors", () => {
    const r = checkPlacement({ ...base, engagement: "ltd" });
    expect(r.errors).toEqual(expect.arrayContaining([
      "Record the IR35 status for a limited-company contractor",
      "A medium or large client must give a Status Determination Statement before the placement starts",
    ]));
    expect(checkPlacement({ ...base, clientSize: "small", engagement: "ltd", ir35Status: "outside" }).errors).toEqual([]);
    const inside = checkPlacement({ ...base, engagement: "ltd", ir35Status: "inside", sdsReceivedOn: "2026-09-30" });
    expect(inside.errors).toEqual([]);
    expect(inside.warnings[0]).toMatch(/fee-payer/);
  });

  it("warns on negative margin and on PAYE pay below the National Living Wage", () => {
    const r = checkPlacement({ ...base, engagement: "paye", kidIssuedOn: "2026-10-01",
      rates: [{ rateType: "standard", payRate: "12.00", chargeRate: "11.00" }] });
    expect(r.warnings).toHaveLength(2);
    expect(nationalLivingWage("2026-03-31")).toBe("12.21");
    expect(nationalLivingWage("2026-04-01")).toBe("12.71");
  });

  it("rejects duplicate rate types", () => {
    expect(checkPlacement({ ...base, engagement: "ltd", clientSize: "small", ir35Status: "outside",
      rates: [rates[0]!, rates[0]!] }).errors).toEqual(['Rate type "standard" is listed twice']);
  });

  it("defaults holiday pay to the 12.07% rolled-up rate only for agency-employed workers", () => {
    expect(engagementDefaults("paye")).toMatchObject({ holidayRate: "0.1207", awrApplies: true, kidRequired: true });
    expect(engagementDefaults("umbrella")).toMatchObject({ holidayRate: "0", awrApplies: true });
    expect(engagementDefaults("ltd")).toMatchObject({ holidayRate: "0", awrApplies: false, kidRequired: false });
  });
});

describe("timesheets", () => {
  const weekEnding = "2026-10-11"; // a Sunday

  it("covers the seven days to the week-ending date", () => {
    expect(weekDays(weekEnding)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"]);
  });

  it("rejects hours outside the week, before the start, on unknown rates or over 24 a day", () => {
    const errors = checkTimesheet({ weekEnding, placementStart: "2026-10-06", rates, entries: [
      { date: "2026-10-04", rateType: "standard", hours: "8" },
      { date: "2026-10-05", rateType: "standard", hours: "8" },
      { date: "2026-10-07", rateType: "night", hours: "8" },
      { date: "2026-10-08", rateType: "standard", hours: "20" },
      { date: "2026-10-08", rateType: "overtime", hours: "5" },
      { date: "2026-10-09", rateType: "standard", hours: "7.125" },
    ] });
    expect(errors).toEqual([
      "2026-10-04 is not in the week ending 2026-10-11",
      "2026-10-04 is before the placement started",
      "2026-10-05 is before the placement started",
      '"night" is not a rate on this placement',
      "Hours on 2026-10-09 can have at most 2 decimal places",
      "More than 24 hours entered on 2026-10-08",
    ]);
  });

  it("prices by rate type with holiday accrual and on-costs", () => {
    const p = priceTimesheet(rates, [
      ...["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"].map((date) => ({ date, rateType: "standard", hours: "7.5" })),
      { date: "2026-10-10", rateType: "overtime", hours: "4" },
    ], { holidayRate: "0.1207", onCostRate: "0.15" });
    expect(p.hours.toString()).toBe("41.5");
    expect(p.byRate.map((r) => [r.rateType, r.hours.toString(), r.pay.toFixed(2), r.charge.toFixed(2)])).toEqual([
      ["standard", "37.5", "543.75", "740.63"],
      ["overtime", "4", "87.00", "118.52"],
    ]);
    expect(p.pay.toFixed(2)).toBe("630.75");
    expect(p.holiday.toFixed(2)).toBe("76.13"); // 630.75 × 12.07% = 76.131…
    expect(p.onCosts.toFixed(2)).toBe("106.03"); // (630.75 + 76.13) × 15% = 106.032
    expect(p.charge.toFixed(2)).toBe("859.15");
    expect(p.cost.toFixed(2)).toBe("812.91");
    expect(p.margin.toFixed(2)).toBe("46.24");
  });

  it("only moves through the approval workflow in order", () => {
    expect(canTransition("draft", "submitted")).toBe(true);
    expect(canTransition("submitted", "approved")).toBe(true);
    expect(canTransition("draft", "approved")).toBe(false);
    expect(canTransition("approved", "rejected")).toBe(false);
    expect(canTransition("invoiced", "approved")).toBe(false);
    expect(canTransition("rejected", "submitted")).toBe(true);
  });
});

describe("postings", () => {
  const hours = fc.integer({ min: 1, max: 6000 }).map((q) => (q / 100).toFixed(2));
  const rate = fc.integer({ min: 0, max: 20_000 }).map((p) => (p / 100).toFixed(2));
  const pct = fc.integer({ min: 0, max: 3000 }).map((b) => (b / 10_000).toFixed(4));

  it("always accrues worker pay as a balanced journal that equals the timesheet cost", () => {
    fc.assert(fc.property(fc.array(fc.tuple(hours, rate, rate), { minLength: 1, maxLength: 4 }), pct, pct, (lines, holidayRate, onCostRate) => {
      const card = lines.map(([, pay, charge], i) => ({ rateType: `r${i}`, payRate: pay, chargeRate: charge }));
      const p = priceTimesheet(card, lines.map(([h], i) => ({ date: "2026-10-05", rateType: `r${i}`, hours: h })), { holidayRate, onCostRate });
      if (p.cost.isZero()) return;
      const j = postWorkerPayAccrual(acc, { date: "2026-10-11", reference: "TS-1", pay: p.pay, holiday: p.holiday, onCosts: p.onCosts }).journal;
      expect(isBalanced(j.lines)).toBe(true);
      expect(sum(j.lines.map((l) => l.debit)).equals(p.cost)).toBe(true);
    }));
  });

  it("posts the accrual to cost of sales and the accrual control accounts", () => {
    const j = postWorkerPayAccrual(acc, { date: "2026-10-11", reference: "TS-00001", pay: "630.75", holiday: "76.13", onCosts: "106.03" }).journal;
    const by = Object.fromEntries(j.lines.map((l) => [l.account, l.debit.minus(l.credit).toFixed(2)]));
    expect(by).toEqual({ "5010": "630.75", "5015": "76.13", "5020": "106.03", "2120": "-736.78", "2125": "-76.13" });
  });

  it("builds invoice lines whose nets equal the approved charge, and a balanced invoice with VAT", () => {
    const p = priceTimesheet(rates, [
      { date: "2026-10-05", rateType: "standard", hours: "37.5" }, { date: "2026-10-10", rateType: "overtime", hours: "4" },
    ]);
    const lines = timesheetInvoiceLines([{ number: "TS-00001", weekEnding: "2026-10-11", workerName: "Sam Okafor", jobTitle: "Warehouse operative", byRate: p.byRate }], "4010");
    expect(lines.map((l) => [l.quantity, l.unitPrice, d(l.net).toFixed(2)])).toEqual([["37.5", "19.75", "740.63"], ["4", "29.63", "118.52"]]);
    expect(lines[0]!.description).toBe("Sam Okafor, Warehouse operative – week ending 11 Oct 2026 – Standard hours (TS-00001)");
    const inv = postSalesInvoice(roleMap(), { date: "2026-10-12", reference: "INV-1", rate: 1, lines });
    expect(isBalanced(inv.journal.lines)).toBe(true);
    expect(inv.total.toFixed(2)).toBe("1030.98"); // 859.15 + VAT 148.13 + 23.70
  });
});

describe("AWR 12-week qualifying period", () => {
  const start = "2026-07-06"; // Monday
  const awr = (over: Partial<AwrInput>) => assessAwr({ start, workedDates: [], absences: [], asOf: "2026-12-31", ...over });

  it("qualifies after 12 weeks worked, from the first day of week 13", () => {
    const r = awr({ workedDates: weekdays(start, 14) });
    expect(r.status).toBe("qualified");
    expect(r.qualifiedOn).toBe("2026-09-28");
    expect(r.weeks[11]).toMatchObject({ start: "2026-09-21", count: 12 });
  });

  it("counts a single day's work as a whole week", () => {
    const days = Array.from({ length: 12 }, (_, i) => addDays(start, i * 7 + 2));
    expect(awr({ workedDates: days }).qualifiedOn).toBe("2026-09-28");
  });

  it("pauses for a break of up to six weeks and resets after a longer one", () => {
    const first = weekdays(start, 5);
    const pausedSix = awr({ workedDates: [...first, ...weekdays(addDays(start, 11 * 7), 7)] });
    expect(pausedSix.weeksCompleted).toBe(12);
    expect(pausedSix.qualifiedOn).toBe(addDays(start, 18 * 7));
    const brokenSeven = awr({ workedDates: [...first, ...weekdays(addDays(start, 12 * 7), 3)], asOf: addDays(start, 15 * 7 - 1) });
    expect(brokenSeven.weeks.some((w) => w.outcome === "reset")).toBe(true);
    expect(brokenSeven.weeksCompleted).toBe(3);
    expect(brokenSeven.clockStart).toBe(addDays(start, 12 * 7));
    expect(brokenSeven.status).toBe("accruing");
  });

  it("pauses for sickness up to 28 weeks, and counts maternity leave as if worked", () => {
    const sick = awr({
      workedDates: [...weekdays(start, 4), ...weekdays(addDays(start, 14 * 7), 8)],
      absences: [{ start: addDays(start, 28), end: addDays(start, 14 * 7 - 1), reason: "sickness" }],
      asOf: "2027-03-31",
    });
    expect(sick.weeks.filter((w) => w.outcome === "paused")).toHaveLength(10);
    expect(sick.status).toBe("qualified");
    const maternity = awr({
      workedDates: weekdays(start, 4),
      absences: [{ start: addDays(start, 28), end: "2027-06-30", reason: "family_leave" }],
    });
    expect(maternity.status).toBe("qualified");
    expect(maternity.qualifiedOn).toBe("2026-09-28");
  });

  it("projects the qualifying date and flags placements qualifying soon", () => {
    const r = awr({ workedDates: weekdays(start, 9), asOf: addDays(start, 9 * 7 - 1) });
    expect(r).toMatchObject({ status: "accruing", weeksCompleted: 9, weeksRemaining: 3, projectedQualifyingDate: "2026-09-28" });
    expect(qualifiesWithin(r, addDays(start, 9 * 7 - 1), 28)).toBe(true);
    expect(qualifiesWithin(r, addDays(start, 9 * 7 - 1), 14)).toBe(false);
  });

  it("treats an unfinished week with no work yet as still to play for", () => {
    const r = awr({ workedDates: weekdays(start, 2), asOf: addDays(start, 14) });
    expect(r.status).toBe("accruing");
    expect(r.weeksCompleted).toBe(2);
    expect(r.projectedQualifyingDate).toBe("2026-09-28");
  });

  it("never counts more weeks than have passed", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 200 }), { maxLength: 120 }), fc.integer({ min: 0, max: 200 }), (offsets, asOfOffset) => {
      const asOf = addDays(start, asOfOffset);
      const r = awr({ workedDates: offsets.map((o) => addDays(start, o)), asOf });
      expect(r.weeksCompleted).toBeLessThanOrEqual(Math.floor(asOfOffset / 7) + 1);
      if (r.qualifiedOn) expect(r.qualifiedOn > start).toBe(true);
    }));
  });
});

describe("margin and permanent fees", () => {
  it("groups gross margin and works out percentages", () => {
    const r = marginReport([
      { key: "a", label: "Acme", hours: "40", charge: "800", cost: "640" },
      { key: "b", label: "Brill", hours: "10", charge: "300", cost: "200" },
      { key: "a", label: "Acme", hours: "20", charge: "400", cost: "330" },
    ]);
    expect(r.rows.map((x) => [x.label, x.margin.toFixed(2), x.marginPct?.toFixed(2), x.marginPerHour?.toFixed(2)])).toEqual([
      ["Acme", "230.00", "19.17", "3.83"],
      ["Brill", "100.00", "33.33", "10.00"],
    ]);
    expect(r.total.margin.toFixed(2)).toBe("330.00");
    expect(marginReport([{ key: "z", label: "Zero", hours: "0", charge: "0", cost: "0" }]).rows[0]!.marginPct).toBeNull();
  });

  it("charges a percentage of salary and rebates on a sliding scale", () => {
    const fee = permFee("42500", "18");
    expect(fee.toFixed(2)).toBe("7650.00");
    expect(permRebate(fee, "2026-09-01", "2026-09-20").toFixed(2)).toBe("7650.00");
    expect(permRebate(fee, "2026-09-01", "2026-10-15").toFixed(2)).toBe("5737.50");
    expect(permRebate(fee, "2026-09-01", "2026-12-01").toFixed(2)).toBe("1912.50");
    expect(permRebate(fee, "2026-09-01", "2027-01-01").toFixed(2)).toBe("0.00");
    expect(() => permRebate(fee, "2026-09-01", "2026-08-01")).toThrow();
  });
});
