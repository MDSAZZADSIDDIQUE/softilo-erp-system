import { createPgliteDatabase, type Database } from "@softilo/db";
import { buildServer } from "@softilo/api/server";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateRecruitment, registerRecruitment } from "./index.js";

let db: Database;
let app: FastifyInstance;

/** A signed-in client: keeps the session cookie between calls. */
function client() {
  let cookie = "";
  const call = async (method: InjectOptions["method"], url: string, body?: unknown) => {
    const res = await app.inject({ method, url, payload: body as InjectOptions["payload"], headers: cookie ? { cookie } : {} });
    const set = res.headers["set-cookie"];
    if (set) cookie = (Array.isArray(set) ? set[0]! : set).split(";")[0]!;
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  const ok = async (method: InjectOptions["method"], url: string, body?: unknown) => {
    const r = await call(method, url, body);
    if (r.status >= 400) throw new Error(`${method} ${url} → ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  return { call, ok };
}

async function balances(c: ReturnType<typeof client>) {
  const accounts = await c.ok("GET", "/api/accounts") as { code: string; balance: string }[];
  return Object.fromEntries(accounts.filter((a) => Number(a.balance) !== 0).map((a) => [a.code, Number(a.balance).toFixed(2)]));
}

async function expectBooksIntact(c: ReturnType<typeof client>) {
  expect((await c.ok("GET", "/api/reports/trial-balance")).balanced).toBe(true);
  expect(await c.ok("GET", "/api/reports/integrity")).toMatchObject({ allReconciled: true });
  expect(await c.ok("GET", "/api/rec/integrity")).toMatchObject({ reconciled: true });
}

const week = (weekEnding: string, hours: Record<string, string>, rateType = "standard") =>
  Object.entries(hours).map(([date, h]) => ({ date, rateType, hours: h }));

beforeAll(async () => {
  db = await createPgliteDatabase();
  await migrateRecruitment(db);
  app = await buildServer(db, {}, [registerRecruitment]);
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe("recruitment agency vertical slice", () => {
  const c = client();
  const ids: Record<string, string> = {};

  it("signs up an agency and sets up a consultant and clients", async () => {
    expect((await c.call("POST", "/api/auth/signup", {
      companyName: "Northbridge Staffing Ltd", companyNumber: "09876543", vatNumber: "GB223344556",
      name: "Alex Morgan", email: "alex@northbridge.example", password: "correct horse battery",
    })).status).toBe(201);
    ids.consultant = (await c.ok("POST", "/api/rec/consultants", { name: "Jordan Lee" })).id;
    ids.client = (await c.ok("POST", "/api/rec/clients", { name: "Midlands Logistics plc", clientSize: "medium_large", paymentTermsDays: 14 })).id;
    ids.small = (await c.ok("POST", "/api/rec/clients", { name: "Fenwick Design Studio", clientSize: "small" })).id;
    expect(await c.ok("GET", "/api/rec/clients")).toHaveLength(2);
  });

  it("registers PAYE, umbrella and limited-company workers", async () => {
    ids.paye = (await c.ok("POST", "/api/rec/workers", { firstName: "Sam", lastName: "Okafor", engagement: "paye", kidIssuedOn: "2026-06-29" })).id;
    ids.umb = (await c.ok("POST", "/api/rec/workers", { firstName: "Priya", lastName: "Nair", engagement: "umbrella", umbrellaName: "Brightline Umbrella Ltd", kidIssuedOn: "2026-06-29" })).id;
    ids.ltd = (await c.ok("POST", "/api/rec/workers", { firstName: "Tom", lastName: "Hale", engagement: "ltd", companyName: "Hale Data Ltd", ir35Status: "outside", conductRegsOptOut: true })).id;
    ids.nokid = (await c.ok("POST", "/api/rec/workers", { firstName: "Ann", lastName: "Price", engagement: "paye" })).id;
    expect((await c.call("POST", "/api/rec/workers", { firstName: "X", lastName: "Y", engagement: "paye", ir35Status: "inside" })).status).toBe(400);
  });

  it("refuses placements that break the compliance rules", async () => {
    const base = { clientId: ids.client, jobTitle: "Warehouse operative", startDate: "2026-07-06", rates: [{ rateType: "standard", payRate: "13.00", chargeRate: "17.50" }] };
    const noKid = await c.call("POST", "/api/rec/placements", { ...base, workerId: ids.nokid });
    expect(noKid.status).toBe(422);
    expect(noKid.body.message).toMatch(/Key Information Document/);
    const noSds = await c.call("POST", "/api/rec/placements", { ...base, workerId: ids.ltd });
    expect(noSds.body.message).toMatch(/Status Determination Statement/);
  });

  it("creates placements with pay and charge rates", async () => {
    const paye = await c.ok("POST", "/api/rec/placements", {
      clientId: ids.client, workerId: ids.paye, consultantId: ids.consultant, jobTitle: "Warehouse operative",
      startDate: "2026-07-06", onCostRate: "0.15",
      rates: [{ rateType: "standard", payRate: "14.50", chargeRate: "19.75" }, { rateType: "overtime", payRate: "21.75", chargeRate: "29.63" }],
    });
    expect(paye.number).toBe("PL-00001");
    ids.pPaye = paye.id;
    ids.pUmb = (await c.ok("POST", "/api/rec/placements", {
      clientId: ids.client, workerId: ids.umb, consultantId: ids.consultant, jobTitle: "Shift supervisor", startDate: "2026-07-06",
      rates: [{ rateType: "standard", payRate: "22.00", chargeRate: "26.40" }],
    })).id;
    ids.pLtd = (await c.ok("POST", "/api/rec/placements", {
      clientId: ids.small, workerId: ids.ltd, jobTitle: "Data engineer", startDate: "2026-09-07",
      rates: [{ rateType: "day", payRate: "500.00", chargeRate: "600.00" }],
    })).id;
    const detail = await c.ok("GET", `/api/rec/placements/${ids.pPaye}`);
    expect(detail).toMatchObject({ holiday_rate: "0.1207", on_cost_rate: "0.1500", awr_applies: true, worker_name: "Sam Okafor" });
    expect((await c.ok("GET", `/api/rec/placements/${ids.pLtd}`)).awr_applies).toBe(false);
  });

  it("validates, submits and approves a weekly timesheet, accruing worker pay as cost of sales", async () => {
    const bad = await c.call("POST", "/api/rec/timesheets", { placementId: ids.pPaye, weekEnding: "2026-07-12",
      entries: [{ date: "2026-07-13", rateType: "standard", hours: "8" }] });
    expect(bad.status).toBe(422);
    const ts = await c.ok("POST", "/api/rec/timesheets", {
      placementId: ids.pPaye, weekEnding: "2026-07-12", submit: true,
      entries: [
        ...week("2026-07-12", { "2026-07-06": "7.5", "2026-07-07": "7.5", "2026-07-08": "7.5", "2026-07-09": "7.5", "2026-07-10": "7.5" }),
        { date: "2026-07-11", rateType: "overtime", hours: "4" },
      ],
    });
    ids.ts1 = ts.id;
    expect((await c.call("POST", "/api/rec/timesheets", { placementId: ids.pPaye, weekEnding: "2026-07-12",
      entries: [{ date: "2026-07-06", rateType: "standard", hours: "1" }] })).status).toBe(422);
    const approved = await c.ok("POST", `/api/rec/timesheets/${ts.id}/approve`, { approvedBy: "Dana Reid (Midlands Logistics)" });
    expect(approved).toMatchObject({ charge: "859.15", cost: "812.91" });
    expect(await balances(c)).toEqual({ "5010": "630.75", "5015": "76.13", "5020": "106.03", "2120": "-736.78", "2125": "-76.13" });
    // Frozen once approved.
    expect((await c.call("PUT", `/api/rec/timesheets/${ts.id}`, { entries: [{ date: "2026-07-06", rateType: "standard", hours: "1" }] })).status).toBe(422);
    await expect(db.tenant((await c.ok("GET", "/api/auth/me")).tenant_id, (tx) =>
      tx.query("UPDATE rec_timesheets SET charge = 1 WHERE id = $1", [ts.id]))).rejects.toThrow(/cannot be changed/);
    await expectBooksIntact(c);
  });

  it("rejects, corrects and resubmits a timesheet", async () => {
    const ts = await c.ok("POST", "/api/rec/timesheets", {
      placementId: ids.pUmb, weekEnding: "2026-07-12", submit: true,
      entries: week("2026-07-12", { "2026-07-06": "10", "2026-07-07": "10" }),
    });
    await c.ok("POST", `/api/rec/timesheets/${ts.id}/reject`, { reason: "Tuesday was 8 hours" });
    expect((await c.call("POST", `/api/rec/timesheets/${ts.id}/approve`, { approvedBy: "Dana" })).status).toBe(422);
    await c.ok("PUT", `/api/rec/timesheets/${ts.id}`, { submit: true, entries: week("2026-07-12", { "2026-07-06": "10", "2026-07-07": "8" }) });
    expect(await c.ok("POST", `/api/rec/timesheets/${ts.id}/approve`, { approvedBy: "Dana Reid" })).toMatchObject({ charge: "475.20", cost: "396.00" });
    ids.ts2 = ts.id;
    await expectBooksIntact(c);
  });

  it("invoices the client from approved timesheets with VAT, and the client pays", async () => {
    const billing = await c.ok("GET", "/api/rec/billing");
    expect(billing).toMatchObject([{ clientName: "Midlands Logistics plc", charge: "1334.35" }]);
    const inv = await c.ok("POST", "/api/rec/invoices", { clientId: ids.client, date: "2026-07-13" });
    expect(inv.total).toBe("1601.22"); // 1334.35 + VAT 171.83 + 23.70 + 95.04 (per line, half-up)
    const doc = await c.ok("GET", `/api/sales-invoices/${inv.id}`);
    expect(doc.lines).toHaveLength(3);
    expect(doc.lines[0]).toMatchObject({ quantity: "37.5000", unit_price: "19.750000", net: "740.63", vat_code: "S20", account_code: "4010" });
    expect(doc.due_date).toBe("2026-07-27");
    expect((await c.ok("GET", `/api/rec/timesheets/${ids.ts1}`)).status).toBe("invoiced");
    expect((await c.call("POST", "/api/rec/invoices", { clientId: ids.client, date: "2026-07-13" })).status).toBe(422);
    const b = await balances(c);
    expect(b).toMatchObject({ "1100": "1601.22", "4010": "-1334.35", "2200": "-266.87" });
    const vat = await c.ok("GET", "/api/vat/preview?from=2026-07-01&to=2026-09-30");
    expect(vat.boxes ?? vat).toMatchObject({ box1: "266.87", box6: "1334" });
    await c.ok("POST", "/api/payments", { direction: "receipt", contactId: ids.client, date: "2026-07-25", bankAccountCode: "1200",
      amount: "1601.22", allocations: [{ documentId: inv.id, amount: "1601.22" }] });
    expect((await balances(c))["1100"]).toBeUndefined();
    await expectBooksIntact(c);
  });

  it("reports gross margin by placement, client and consultant", async () => {
    const byClient = await c.ok("GET", "/api/rec/margin?by=client");
    expect(byClient.rows).toEqual([expect.objectContaining({ label: "Midlands Logistics plc", charge: "1334.35", cost: "1208.91", margin: "125.44", marginPct: "9.40" })]);
    const byConsultant = await c.ok("GET", "/api/rec/margin?by=consultant");
    expect(byConsultant.rows[0]).toMatchObject({ label: "Jordan Lee", margin: "125.44" });
    const byPlacement = await c.ok("GET", "/api/rec/margin?by=placement");
    expect(byPlacement.rows.map((r: { margin: string }) => r.margin)).toEqual(["79.20", "46.24"]);
    expect(byPlacement.total).toMatchObject({ hours: "59.50", margin: "125.44" });
  });

  it("tracks the 12-week AWR qualifying period from timesheets and absences", async () => {
    let awr = await c.ok("GET", "/api/rec/awr?asOf=2026-07-12");
    expect(awr.find((a: { id: string }) => a.id === ids.pPaye)).toMatchObject({ status: "accruing", weeksCompleted: 1, weeksRemaining: 11, projectedQualifyingDate: "2026-09-28" });
    expect(awr.find((a: { id: string }) => a.id === ids.pLtd)).toBeUndefined();
    // Two weeks' annual leave pause the clock; eleven more weeks of work complete the twelve.
    await c.ok("POST", `/api/rec/placements/${ids.pPaye}/absences`, { startDate: "2026-07-13", endDate: "2026-07-26", reason: "annual_leave" });
    for (let i = 0; i < 11; i++) {
      const start = new Date(Date.UTC(2026, 6, 27 + i * 7));
      const iso = (dt: Date) => dt.toISOString().slice(0, 10);
      const weekEnding = iso(new Date(start.getTime() + 6 * 86_400_000));
      const ts = await c.ok("POST", "/api/rec/timesheets", { placementId: ids.pPaye, weekEnding, submit: true,
        entries: [{ date: iso(start), rateType: "standard", hours: "8" }] });
      await c.ok("POST", `/api/rec/timesheets/${ts.id}/approve`, { approvedBy: "Dana Reid" });
    }
    awr = await c.ok("GET", "/api/rec/awr?asOf=2026-10-12");
    expect(awr.find((a: { id: string }) => a.id === ids.pPaye)).toMatchObject({ status: "qualified", weeksCompleted: 12, qualifiedOn: "2026-10-12" });
    await expectBooksIntact(c);
  });

  it("keeps each agency's data private", async () => {
    const other = client();
    await other.ok("POST", "/api/auth/signup", { companyName: "Rival Recruitment Ltd", name: "Kim", email: "kim@rival.example", password: "another long password" });
    expect(await other.ok("GET", "/api/rec/placements")).toEqual([]);
    expect(await other.ok("GET", "/api/rec/timesheets")).toEqual([]);
    expect((await other.call("GET", `/api/rec/placements/${ids.pPaye}`)).status).toBe(404);
    expect((await other.call("POST", `/api/rec/timesheets/${ids.ts1}/approve`, { approvedBy: "x" })).status).toBe(404);
  });
});
