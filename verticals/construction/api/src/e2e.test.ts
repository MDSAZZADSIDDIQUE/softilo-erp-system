import { createPgliteDatabase, type Database } from "@softilo/db";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildConstructionServer, migrateConstruction } from "./server.js";

let db: Database;
let app: FastifyInstance;

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
  expect(await c.ok("GET", "/api/construction/integrity")).toMatchObject({ allReconciled: true });
}

beforeAll(async () => {
  db = await createPgliteDatabase();
  await migrateConstruction(db);
  app = await buildConstructionServer(db);
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe("construction vertical slice", () => {
  const c = client();
  const ids: Record<string, string> = {};

  it("signs up a contractor and records its CIS references", async () => {
    await c.ok("POST", "/api/auth/signup", {
      companyName: "Brick & Beam Contractors Ltd", companyNumber: "11223344", vatNumber: "GB223344556",
      name: "Dev Patel", email: "dev@brickbeam.example", password: "correct horse battery",
    });
    expect((await c.call("PUT", "/api/construction/settings", { contractorUtr: "123", employerRef: "123/AB45678" })).status).toBe(400);
    await c.ok("PUT", "/api/construction/settings", { contractorUtr: "1234567890", employerRef: "123/AB45678", accountsOfficeRef: "123PA00012345" });
    expect(await c.ok("GET", "/api/construction/settings")).toMatchObject({ contractor_utr: "1234567890", employer_ref: "123/AB45678" });
  });

  it("sets up projects with budgets", async () => {
    ids.developer = (await c.ok("POST", "/api/contacts", { kind: "customer", name: "Northgate Developments Ltd", vatNumber: "GB998877665" })).id;
    ids.school = (await c.ok("POST", "/api/contacts", { kind: "customer", name: "St Anne's Academy Trust", vatNumber: "GB556677889" })).id;
    ids.project = (await c.ok("POST", "/api/construction/projects", {
      code: "NG01", name: "Northgate flats, block A", customerId: ids.developer, contractSum: "100000.00", retentionRate: "0.05",
      budget: [
        { category: "labour", description: "Brickwork and groundworks", amount: "40000" },
        { category: "materials", description: "Bricks, blocks, concrete", amount: "30000" },
        { category: "plant", description: "Excavator and scaffold", amount: "5000" },
      ],
    })).id;
    // The academy has confirmed in writing that it is an end user, so normal VAT applies.
    ids.schoolProject = (await c.ok("POST", "/api/construction/projects", {
      code: "SA01", name: "Academy sports hall", customerId: ids.school, contractSum: "20000", retentionRate: "0.03", endUserNotice: true,
    })).id;
    const dup = await c.call("POST", "/api/construction/projects", { code: "NG01", name: "x", customerId: ids.developer, contractSum: "1" });
    expect(dup.status).toBe(422);
    expect(await c.ok("GET", "/api/construction/projects")).toHaveLength(2);
  });

  it("adds subcontractors and verifies them with HMRC (stub)", async () => {
    ids.ace = (await c.ok("POST", "/api/construction/subcontractors", { name: "Ace Brickwork Ltd", vatNumber: "GB111222333", businessType: "company", utr: "2222222222", companyNumber: "09876543" })).id;
    ids.smith = (await c.ok("POST", "/api/construction/subcontractors", { name: "J Smith Groundworks", businessType: "sole_trader", utr: "3333333338", nino: "AB123456C" })).id;
    ids.gross = (await c.ok("POST", "/api/construction/subcontractors", { name: "Gross Roofing Ltd", businessType: "company", utr: "4444444440" })).id;
    // Unverified subcontractors cannot be billed.
    const early = await c.call("POST", "/api/construction/bills", { supplierId: ids.ace, projectId: ids.project, supplierRef: "ACE-1", date: "2026-10-10",
      lines: [{ category: "labour", description: "Brickwork", net: "100" }] });
    expect(early.status).toBe(422);
    expect(early.body.message).toMatch(/Verify/);
    expect(await c.ok("POST", `/api/construction/subcontractors/${ids.ace}/verify`)).toMatchObject({ status: "net", gateway: "stub" });
    const smith = await c.ok("POST", `/api/construction/subcontractors/${ids.smith}/verify`);
    expect(smith.status).toBe("unmatched");
    expect(smith.verificationNumber).toMatch(/^V\d{10}A$/);
    expect((await c.ok("POST", `/api/construction/subcontractors/${ids.gross}/verify`)).status).toBe("gross");
  });

  it("deducts CIS on labour only and posts it to the CIS liability", async () => {
    const ace = await c.ok("POST", "/api/construction/bills", {
      supplierId: ids.ace, projectId: ids.project, supplierRef: "ACE-1", date: "2026-10-10",
      lines: [
        { category: "labour", description: "Brickwork, block A ground floor", net: "2000.00" },
        { category: "materials", description: "Wall ties and mortar", net: "500.00" },
      ],
    });
    // VAT-registered subcontractor → domestic reverse charge; 20% of £2,000 labour = £400.
    expect(ace).toMatchObject({ payable: "2100.00", cis: { rate: "0.20", gross: "2500.00", materials: "500.00", deduction: "400.00" } });
    ids.aceBill = ace.id;
    const smith = await c.ok("POST", "/api/construction/bills", {
      supplierId: ids.smith, projectId: ids.project, supplierRef: "JS-07", date: "2026-10-12",
      lines: [{ category: "labour", description: "Foundations dig", net: "1000.00" }],
    });
    expect(smith).toMatchObject({ payable: "700.00", cis: { deduction: "300.00" } });
    ids.smithBill = smith.id;
    ids.merchant = (await c.ok("POST", "/api/contacts", { kind: "supplier", name: "Midland Builders Merchants", vatNumber: "GB444555666" })).id;
    const merchant = await c.ok("POST", "/api/construction/bills", {
      supplierId: ids.merchant, projectId: ids.project, supplierRef: "MBM-501", date: "2026-10-14",
      lines: [{ category: "materials", description: "Engineering bricks", net: "100.00" }],
    });
    expect(merchant).toMatchObject({ payable: "120.00", cis: null });
    const b = await balances(c);
    expect(b).toMatchObject({ "2211": "-700.00", "2100": "-2920.00", "5300": "3000.00", "5310": "600.00", "2201": "520.00", "2200": "-500.00" });
    await expectBooksIntact(c);
  });

  it("reports subcontractor payments on the CIS300 in the month they are paid", async () => {
    await c.ok("POST", "/api/payments", { direction: "payment", contactId: ids.ace, date: "2026-10-20", bankAccountCode: "1200", amount: "2100.00",
      allocations: [{ documentId: ids.aceBill, amount: "2100.00" }] });
    await c.ok("POST", "/api/payments", { direction: "payment", contactId: ids.smith, date: "2026-10-20", bankAccountCode: "1200", amount: "350.00",
      allocations: [{ documentId: ids.smithBill, amount: "350.00" }] });
    await c.ok("POST", "/api/payments", { direction: "payment", contactId: ids.smith, date: "2026-11-10", bankAccountCode: "1200", amount: "350.00",
      allocations: [{ documentId: ids.smithBill, amount: "350.00" }] });

    const nov = await c.ok("GET", "/api/construction/cis/preview?monthEnding=2026-11-05");
    expect(nov.month).toMatchObject({ start: "2026-10-06", returnDue: "2026-11-19", paymentDue: "2026-11-22" });
    expect(nov.totals).toEqual({ grossPaid: "3000.00", costOfMaterials: "500.00", amountDeducted: "550.00", subcontractors: 2 });
    const smith = nov.statements.find((s: { subcontractor: { id: string } }) => s.subcontractor.id === ids.smith);
    expect(smith).toMatchObject({ grossPaid: "500.00", amountDeducted: "150.00", netPaid: "350.00" });
    expect(smith.verificationNumber).toMatch(/A$/);
    const dec = await c.ok("GET", "/api/construction/cis/preview?monthEnding=2026-12-05");
    expect(dec.totals).toMatchObject({ grossPaid: "500.00", amountDeducted: "150.00" });
    expect((await c.ok("GET", "/api/construction/cis/preview?monthEnding=2026-10-05")).nil).toBe(true);
    expect((await c.call("GET", "/api/construction/cis/preview?monthEnding=2026-11-30")).status).toBe(422);
  });

  it("submits the CIS300 through the HMRC adapter once per month", async () => {
    const r = await c.ok("POST", "/api/construction/cis/returns", { monthEnding: "2026-11-05", declarations: { employmentStatus: true, verification: true } });
    expect(r.receipt.correlationId).toHaveLength(32);
    expect(r.totals.amountDeducted).toBe("550.00");
    const again = await c.call("POST", "/api/construction/cis/returns", { monthEnding: "2026-11-05", declarations: { employmentStatus: true, verification: true } });
    expect(again.status).toBe(422);
    expect((await c.ok("GET", "/api/construction/cis/preview?monthEnding=2026-11-05")).submitted).not.toBeNull();
  });

  it("applies for payment with retention held and the reverse charge", async () => {
    const a1 = await c.ok("POST", `/api/construction/projects/${ids.project}/applications`, { date: "2026-10-31", periodEnd: "2026-10-31", grossToDate: "40000.00" });
    expect(a1).toMatchObject({
      reference: "NG01-AFP01", amountDue: "38000.00", retentionToDate: "2000.00", vatCode: "RC20", total: "38000.00",
      dueDate: "2026-11-07", finalDate: "2026-11-24", payLessNoticeBy: "2026-11-17",
    });
    ids.a1 = a1.id;
    let b = await balances(c);
    expect(b).toMatchObject({ "1100": "38000.00", "1105": "2000.00", "4000": "-40000.00" });
    // Practical completion: half the retention is released and invoiced.
    const a2 = await c.ok("POST", `/api/construction/projects/${ids.project}/applications`, {
      date: "2026-12-15", periodEnd: "2026-12-15", grossToDate: "100000.00", stage: "practical_completion" });
    expect(a2).toMatchObject({ reference: "NG01-AFP02", amountDue: "59500.00", retentionToDate: "2500.00" });
    b = await balances(c);
    expect(b).toMatchObject({ "1105": "2500.00", "4000": "-100000.00", "1100": "97500.00" });
    const lower = await c.call("POST", `/api/construction/projects/${ids.project}/applications`, { date: "2026-12-20", periodEnd: "2026-12-20", grossToDate: "90000" });
    expect(lower.status).toBe(422);
    const detail = await c.ok("GET", `/api/construction/applications/${ids.a1}`);
    expect(detail.reverseCharge).toBe(true);
    await expectBooksIntact(c);
  });

  it("charges VAT normally for an end user", async () => {
    const a = await c.ok("POST", `/api/construction/projects/${ids.schoolProject}/applications`, { date: "2026-10-31", periodEnd: "2026-10-31", grossToDate: "10000" });
    expect(a).toMatchObject({ vatCode: "S20", amountDue: "9700.00", total: "11640.00" });
    const vat = await c.ok("GET", "/api/vat/preview?from=2026-10-01&to=2026-12-31");
    // Box 1: £1,940 sales VAT + £500 reverse charge on subcontractor bills. Box 6 includes reverse-charge sales (£97,500).
    expect(vat.boxes).toMatchObject({ box1: "2440.00", box4: "520.00", box6: "107200" });
    await expectBooksIntact(c);
  });

  it("tracks variations and job cost against budget", async () => {
    const v = await c.ok("POST", `/api/construction/projects/${ids.project}/variations`, { description: "Extra drainage run", amount: "4500", date: "2026-11-02" });
    expect(v.number).toBe("V001");
    await c.ok("POST", `/api/construction/variations/${v.id}/approve`);
    expect((await c.call("POST", `/api/construction/variations/${v.id}/reject`)).status).toBe(422);
    const p = await c.ok("GET", `/api/construction/projects/${ids.project}`);
    expect(p.summary).toMatchObject({ contractValue: "104500.00", budgetTotal: "75000.00", costToDate: "3600.00", valuedToDate: "100000.00", marginToDate: "96400.00" });
    expect(p.summary.categories.find((x: { category: string }) => x.category === "labour")).toMatchObject({ actual: "3000.00", remaining: "37000.00" });
    expect(p.applications).toHaveLength(2);
    expect(p.bills).toHaveLength(3);
  });

  it("refuses manual journals on the retention account", async () => {
    const r = await c.call("POST", "/api/journals", { date: "2026-12-31", memo: "fiddle", lines: [{ accountCode: "1105", debit: "100" }, { accountCode: "4000", credit: "100" }] });
    expect(r.status).toBe(422);
  });

  it("keeps other companies' projects invisible", async () => {
    const other = client();
    await other.ok("POST", "/api/auth/signup", { companyName: "Other Build Ltd", name: "Sam", email: "sam@otherbuild.example", password: "another long password" });
    expect(await other.ok("GET", "/api/construction/projects")).toEqual([]);
    expect(await other.ok("GET", "/api/construction/subcontractors")).toEqual([]);
    expect((await other.call("GET", `/api/construction/projects/${ids.project}`)).status).toBe(404);
  });
});
