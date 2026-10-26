import { createPgliteDatabase, migrate, type Database } from "@softilo/db";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

let db: Database;
let app: FastifyInstance;

/** A signed-in client: keeps the session cookie between calls. */
function client() {
  let cookie = "";
  const call = async (method: InjectOptions["method"], url: string, body?: unknown) => {
    const res = await app.inject({ method, url, payload: body as InjectOptions["payload"], headers: cookie ? { cookie } : {} });
    const set = res.headers["set-cookie"];
    if (set) cookie = (Array.isArray(set) ? set[0]! : set).split(";")[0]!;
    const json = res.body ? res.json() : undefined;
    return { status: res.statusCode, body: json };
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
  return Object.fromEntries(accounts.filter((a) => a.balance !== "0" && Number(a.balance) !== 0).map((a) => [a.code, Number(a.balance).toFixed(2)]));
}

async function expectBooksIntact(c: ReturnType<typeof client>) {
  const tb = await c.ok("GET", "/api/reports/trial-balance");
  expect(tb.balanced).toBe(true);
  const integrity = await c.ok("GET", "/api/reports/integrity");
  expect(integrity).toMatchObject({ allReconciled: true });
}

beforeAll(async () => {
  db = await createPgliteDatabase();
  await migrate(db);
  app = await buildServer(db);
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe("importer vertical slice", () => {
  const c = client();
  const ids: Record<string, string> = {};

  it("signs up a company with a UK chart of accounts", async () => {
    const r = await c.call("POST", "/api/auth/signup", {
      companyName: "Thames Imports Ltd", companyNumber: "12345678", vatNumber: "GB123456789",
      name: "Priya Shah", email: "priya@thames.example", password: "correct horse battery",
    });
    expect(r.status).toBe(201);
    const me = await c.ok("GET", "/api/auth/me");
    expect(me).toMatchObject({ tenant_name: "Thames Imports Ltd", role: "owner" });
    const accounts = await c.ok("GET", "/api/accounts") as unknown[];
    expect(accounts.length).toBeGreaterThan(20);
  });

  it("sets up contacts and products", async () => {
    ids.supplier = (await c.ok("POST", "/api/contacts", { kind: "supplier", name: "Shenzhen Widget Co", currency: "USD" })).id;
    ids.freight = (await c.ok("POST", "/api/contacts", { kind: "supplier", name: "Felixstowe Freight Ltd", vatNumber: "GB987654321" })).id;
    ids.customer = (await c.ok("POST", "/api/contacts", { kind: "customer", name: "Bristol Retail plc", paymentTermsDays: 30 })).id;
    ids.widget = (await c.ok("POST", "/api/products", { sku: "WID-001", name: "Steel widget", hsCode: "7326909890", weightKg: "2", salesPrice: "25", reorderLevel: "50" })).id;
    ids.gadget = (await c.ok("POST", "/api/products", { sku: "GAD-001", name: "Brass gadget", hsCode: "7419999000", weightKg: "1", salesPrice: "40" })).id;
  });

  it("orders in USD, approves and receives goods into stock", async () => {
    const po = await c.ok("POST", "/api/purchase-orders", {
      supplierId: ids.supplier, date: "2026-07-01", rate: "0.80",
      lines: [
        { productId: ids.widget, quantity: 100, unitPrice: "10.00", vatCode: "OS" },
        { productId: ids.gadget, quantity: 50, unitPrice: "20.00", vatCode: "OS" },
      ],
    });
    ids.po = po.id;
    expect((await c.call("POST", `/api/purchase-orders/${po.id}/receive`, { date: "2026-07-20", lines: [] })).status).toBe(400);
    await c.ok("POST", `/api/purchase-orders/${po.id}/approve`);
    const detail = await c.ok("GET", `/api/purchase-orders/${po.id}`);
    await c.ok("POST", `/api/purchase-orders/${po.id}/receive`, {
      date: "2026-07-20", lines: detail.lines.map((l: { id: string; quantity: string }) => ({ poLineId: l.id, quantity: l.quantity })),
    });
    // $1,000 + $1,000 at 0.80 = £1,600 into stock against goods received not invoiced.
    expect(await balances(c)).toMatchObject({ "1001": "1600.00", "2105": "-1600.00" });
    expect((await c.ok("GET", `/api/purchase-orders/${po.id}`)).status).toBe("received");
    await expectBooksIntact(c);
  });

  it("refuses to over-receive", async () => {
    const detail = await c.ok("GET", `/api/purchase-orders/${ids.po}`);
    const r = await c.call("POST", `/api/purchase-orders/${ids.po}/receive`, { date: "2026-07-21", lines: [{ poLineId: detail.lines[0].id, quantity: 1 }] });
    expect(r.status).toBe(422);
  });

  it("bills the goods at a different exchange rate and posts the variance", async () => {
    const unbilled = await c.ok("GET", `/api/goods-receipts/unbilled?supplierId=${ids.supplier}`) as { id: string }[];
    expect(unbilled).toHaveLength(2);
    await c.ok("POST", "/api/supplier-bills", {
      supplierId: ids.supplier, supplierRef: "SWC-8812", date: "2026-07-22", rate: "0.81",
      lines: unbilled.map((u) => ({ kind: "receipt", receiptLineId: u.id })),
    });
    // $2,000 at 0.81 = £1,620 owed; £20 purchase price variance.
    expect(await balances(c)).toMatchObject({ "2100": "-1620.00", "5100": "20.00" });
    expect((await balances(c))["2105"]).toBeUndefined();
    const dup = await c.call("POST", "/api/supplier-bills", {
      supplierId: ids.supplier, supplierRef: "SWC-8812", date: "2026-07-22", rate: "0.81",
      lines: [{ kind: "account", accountCode: "7500", description: "x", net: "1", vatCode: "OS" }],
    });
    expect(dup.status).toBe(422);
    await expectBooksIntact(c);
  });

  it("books freight and duty to landed-cost clearing, then lands them on the stock", async () => {
    await c.ok("POST", "/api/supplier-bills", {
      supplierId: ids.freight, supplierRef: "FF-1001", date: "2026-07-23",
      lines: [
        { kind: "account", accountCode: "2110", description: "Sea freight", net: "300.00", vatCode: "S20" },
        { kind: "account", accountCode: "2110", description: "Import duty", net: "100.00", vatCode: "OS" },
      ],
    });
    const lines = await c.ok("GET", `/api/purchase-orders/${ids.po}`);
    const shp = await c.ok("POST", "/api/shipments", {
      reference: "MSCU1234567", mrn: "26GB1234567890ABC1", date: "2026-07-20",
      receiptLineIds: lines.receipts.map((r: { line_id: string }) => r.line_id),
    });
    ids.shipment = shp.id;
    await c.ok("POST", `/api/shipments/${shp.id}/costs`, { description: "Sea freight", amountGbp: "300.00", method: "weight" });
    await c.ok("POST", `/api/shipments/${shp.id}/costs`, { description: "Import duty", amountGbp: "100.00", method: "value" });
    const preview = await c.ok("GET", `/api/shipments/${shp.id}`);
    // Weight: widgets 200kg, gadgets 50kg → freight £240 / £60. Value: £800 each → duty £50 / £50.
    const landed = Object.fromEntries(preview.lines.map((l: { sku: string; landed: string; unit_landed_cost: string }) => [l.sku, [l.landed, l.unit_landed_cost]]));
    expect(landed).toEqual({ "GAD-001": ["110.00", "18.200000"], "WID-001": ["290.00", "10.900000"] });
    await c.ok("POST", `/api/shipments/${shp.id}/post`, { date: "2026-07-24" });
    const b = await balances(c);
    expect(b["1001"]).toBe("2000.00");
    expect(b["2110"]).toBeUndefined();
    expect((await c.call("POST", `/api/shipments/${shp.id}/post`, { date: "2026-07-24" })).status).toBe(422);
    await expectBooksIntact(c);
  });

  it("sells stock at weighted-average landed cost", async () => {
    const inv = await c.ok("POST", "/api/sales-invoices", {
      customerId: ids.customer, date: "2026-08-01",
      lines: [{ productId: ids.widget, quantity: 40, unitPrice: "25.00" }, { productId: ids.gadget, quantity: 10, unitPrice: "40.00" }],
    });
    ids.invoice = inv.id;
    expect(inv.number).toBe("INV-00001");
    const b = await balances(c);
    // Sales £1,400 + VAT £280; cost 40 × £10.90 + 10 × £18.20 = £618.
    expect(b).toMatchObject({ "1100": "1680.00", "4000": "-1400.00", "2200": "-280.00", "5000": "618.00", "1001": "1382.00" });
    const tooMany = await c.call("POST", "/api/sales-invoices", {
      customerId: ids.customer, date: "2026-08-01", lines: [{ productId: ids.gadget, quantity: 1000, unitPrice: "1" }],
    });
    expect(tooMany.status).toBe(422);
    expect((await c.ok("GET", "/api/sales-invoices")).length).toBe(1);
    await expectBooksIntact(c);
  });

  it("credits a returned item back into stock", async () => {
    await c.ok("POST", "/api/credit-notes", {
      customerId: ids.customer, date: "2026-08-03", creditsId: ids.invoice,
      lines: [{ productId: ids.widget, quantity: 2, unitPrice: "25.00", returnToStock: true }],
    });
    const b = await balances(c);
    expect(b).toMatchObject({ "1100": "1620.00", "4000": "-1350.00", "2200": "-270.00", "5000": "596.20" });
    await expectBooksIntact(c);
  });

  it("receives payment and pays the supplier with realised FX", async () => {
    const credits = (await c.ok("GET", "/api/sales-invoices") as { id: string; kind: string }[]).find((i) => i.kind === "credit")!;
    await c.ok("POST", `/api/credit-notes/${credits.id}/apply`, { invoiceId: ids.invoice, amount: "60.00" });
    await c.ok("POST", "/api/payments", {
      direction: "receipt", contactId: ids.customer, date: "2026-08-20", bankAccountCode: "1200", amount: "1620.00",
      allocations: [{ documentId: ids.invoice, amount: "1620.00" }],
    });
    const bill = (await c.ok("GET", "/api/supplier-bills") as { id: string; supplier_ref: string }[]).find((x) => x.supplier_ref === "SWC-8812")!;
    await c.ok("POST", "/api/payments", {
      direction: "payment", contactId: ids.supplier, date: "2026-08-21", bankAccountCode: "1200", amount: "2000.00", rate: "0.79",
      allocations: [{ documentId: bill.id, amount: "2000.00" }],
    });
    const b = await balances(c);
    // Paid $2,000 at 0.79 = £1,580 against £1,620 owed → £40 FX gain.
    expect(b).toMatchObject({ "1200": "40.00", "8000": "-40.00" });
    expect(b["1100"]).toBeUndefined();
    const inv = await c.ok("GET", `/api/sales-invoices/${ids.invoice}`);
    expect(inv.outstanding).toBe("0.00");
    await expectBooksIntact(c);
  });

  it("imports a bank statement, matches the receipt and codes a bank charge", async () => {
    const csv = [
      "Date,Description,Reference,Paid in,Paid out",
      "20/08/2026,BRISTOL RETAIL PLC,INV-00001,\"1,620.00\",",
      "21/08/2026,SHENZHEN WIDGET CO,SWC-8812,,1580.00",
      "31/08/2026,ACCOUNT FEE,,,12.50",
    ].join("\n");
    const r = await c.ok("POST", "/api/bank/import", { bankAccountCode: "1200", content: csv });
    expect(r).toEqual({ lines: 3, imported: 3, duplicates: 0 });
    expect(await c.ok("POST", "/api/bank/import", { bankAccountCode: "1200", content: csv })).toMatchObject({ imported: 0, duplicates: 3 });
    const txns = await c.ok("GET", "/api/bank/transactions?status=unreconciled") as { id: string; amount: string; description: string }[];
    for (const t of txns.filter((x) => x.description !== "ACCOUNT FEE")) {
      const s = await c.ok("GET", `/api/bank/transactions/${t.id}/suggestions`);
      expect(s.payments).toHaveLength(1);
      await c.ok("POST", `/api/bank/transactions/${t.id}/match`, { paymentId: s.payments[0].id });
    }
    const fee = txns.find((x) => x.description === "ACCOUNT FEE")!;
    await c.ok("POST", `/api/bank/transactions/${fee.id}/post`, { accountCode: "7900", vatCode: "EX" });
    const accts = await c.ok("GET", "/api/bank-accounts") as { code: string; balance: string; statement_balance: string; unreconciled: string }[];
    const current = accts.find((a) => a.code === "1200")!;
    expect(Number(current.balance)).toBeCloseTo(27.5);
    expect(Number(current.statement_balance)).toBeCloseTo(27.5);
    expect(Number(current.unreconciled)).toBe(0);
  });

  it("records postponed import VAT against the shipment's MRN", async () => {
    const r = await c.ok("POST", "/api/vat/pva", {
      statement: "2026-07", entries: [{ mrn: "26GB1234567890ABC1", date: "2026-07-20", valueGbp: "1700.00", vatGbp: "340.00" }],
    });
    expect(r.unmatched).toEqual([]);
  });

  it("finalises the VAT return and locks the period", async () => {
    const preview = await c.ok("GET", "/api/vat/preview?from=2026-07-01&to=2026-09-30");
    // Box 1: sales VAT £270 + PVA £340. Box 4: freight VAT £60 + PVA £340.
    // Box 7: freight £300 + import value £1,700 + exempt bank fee £12.50 (overseas goods bill and duty are outside scope).
    expect(preview.boxes).toMatchObject({ box1: "610.00", box4: "400.00", box5: "210.00", box6: "1350", box7: "2012" });
    await c.ok("POST", "/api/vat/returns", { periodKey: "26C3", from: "2026-07-01", to: "2026-09-30" });
    const b = await balances(c);
    expect(b["2200"]).toBeUndefined();
    expect(b["2201"]).toBeUndefined();
    expect(b["2202"]).toBe("-210.00");
    // The period is now locked: back-dated postings are refused by the database.
    const late = await c.call("POST", "/api/journals", { date: "2026-09-15", memo: "late", lines: [
      { accountCode: "7500", debit: "10" }, { accountCode: "1200", credit: "10" }] });
    expect(late.status).toBe(422);
    expect(late.body.message).toMatch(/locked/);
    const again = await c.call("POST", "/api/vat/returns", { periodKey: "26C3b", from: "2026-07-01", to: "2026-09-30" });
    expect(again.status).toBe(422);
    await expectBooksIntact(c);
  });

  it("refuses manual journals on control accounts", async () => {
    const r = await c.call("POST", "/api/journals", { date: "2026-10-01", memo: "fiddle", lines: [
      { accountCode: "1100", debit: "100" }, { accountCode: "4000", credit: "100" }] });
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/control account/);
  });

  it("produces statements that balance", async () => {
    const pl = await c.ok("GET", "/api/reports/profit-and-loss?from=2026-01-01&to=2026-12-31");
    expect(pl.totals).toMatchObject({ income: "1350.00" });
    const bs = await c.ok("GET", "/api/reports/balance-sheet?asAt=2026-12-31");
    expect(bs.balanced).toBe(true);
    const dash = await c.ok("GET", "/api/dashboard");
    expect(dash.stock).toBe("1403.80");
    const audit = await c.ok("GET", "/api/audit") as unknown[];
    expect(audit.length).toBeGreaterThan(10);
  });

  it("keeps other companies' data invisible", async () => {
    const other = client();
    await other.ok("POST", "/api/auth/signup", { companyName: "Other Ltd", name: "Sam", email: "sam@other.example", password: "another long password" });
    expect(await other.ok("GET", "/api/sales-invoices")).toEqual([]);
    expect((await other.call("GET", `/api/sales-invoices/${ids.invoice}`)).status).toBe(404);
    expect(await other.ok("GET", "/api/contacts")).toEqual([]);
  });

  it("rejects requests without a session", async () => {
    const anon = await app.inject({ method: "GET", url: "/api/dashboard" });
    expect(anon.statusCode).toBe(401);
    const bad = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "priya@thames.example", password: "wrong" } });
    expect(bad.statusCode).toBe(401);
  });
});
