import { buildServer } from "@softilo/api/server";
import { createPgliteDatabase, newId, type Database } from "@softilo/db";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateFoodBeverage } from "./migrate.js";
import { registerFoodBeverage } from "./module.js";

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

async function expectBooksIntact(c: ReturnType<typeof client>) {
  expect((await c.ok("GET", "/api/reports/trial-balance")).balanced).toBe(true);
  expect(await c.ok("GET", "/api/reports/integrity")).toMatchObject({ allReconciled: true });
  const expiry = await c.ok("GET", "/api/fnb/reports/expiry?asAt=2026-10-26");
  expect(expiry.integrity).toEqual({ reconciled: true, mismatches: [] });
}

beforeAll(async () => {
  db = await createPgliteDatabase();
  await migrateFoodBeverage(db);
  app = await buildServer(db, {}, [registerFoodBeverage]);
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe("food & beverage: batches, FEFO, expiry and recall", () => {
  const c = client();
  const ids: Record<string, string> = {};
  const batch: Record<string, string> = {};

  it("sets up a chilled food wholesaler", async () => {
    expect((await c.call("POST", "/api/auth/signup", {
      companyName: "Severn Fine Foods Ltd", name: "Tom Hughes", email: "tom@severn.example", password: "correct horse battery",
    })).status).toBe(201);
    ids.supplier = (await c.ok("POST", "/api/contacts", { kind: "supplier", name: "Dairy Co-op Ltd" })).id;
    ids.cafe = (await c.ok("POST", "/api/contacts", { kind: "customer", name: "Harbour Café", email: "orders@harbour.example" })).id;
    ids.school = (await c.ok("POST", "/api/contacts", { kind: "customer", name: "Riverside School" })).id;
    ids.yoghurt = (await c.ok("POST", "/api/products", { sku: "YOG-500", name: "Greek yoghurt 500g", salesPrice: "2.40", salesVatCode: "Z0", purchaseVatCode: "Z0" })).id;
    ids.oil = (await c.ok("POST", "/api/products", { sku: "OIL-1L", name: "Olive oil 1L", salesPrice: "6.00", salesVatCode: "Z0", purchaseVatCode: "Z0" })).id;
    ids.napkin = (await c.ok("POST", "/api/products", { sku: "NAP-100", name: "Napkins x100", salesPrice: "1.50" })).id;

    await c.ok("PUT", `/api/fnb/products/${ids.yoghurt}/settings`, { dateType: "use_by", storage: "chilled", allergens: ["milk"] });
    await c.ok("PUT", `/api/fnb/products/${ids.oil}/settings`, { dateType: "best_before", shelfLifeDays: 365 });
    await c.ok("PUT", `/api/fnb/customers/${ids.school}/settings`, { minLifeDays: 10 });
    const bad = await c.call("PUT", `/api/fnb/products/${ids.oil}/settings`, { allergens: ["chocolate"] });
    expect(bad.status).toBe(400);
  });

  it("receives two yoghurt batches and one oil batch with date marks", async () => {
    const po = await c.ok("POST", "/api/purchase-orders", {
      supplierId: ids.supplier, date: "2026-10-01",
      lines: [
        { productId: ids.yoghurt, quantity: 200, unitPrice: "1.20" },
        { productId: ids.oil, quantity: 50, unitPrice: "3.00" },
        { productId: ids.napkin, quantity: 20, unitPrice: "0.50" },
      ],
    });
    await c.ok("POST", `/api/purchase-orders/${po.id}/approve`);
    const detail = await c.ok("GET", `/api/purchase-orders/${po.id}`);
    const line = (pid?: string) => detail.lines.find((l: { product_id: string }) => l.product_id === pid).id;

    // The core route refuses batch-tracked products, so batches can never be skipped.
    const core = await c.call("POST", `/api/purchase-orders/${po.id}/receive`, { date: "2026-10-01", lines: [{ poLineId: line(ids.yoghurt), quantity: 1 }] });
    expect(core.status).toBe(422);
    expect(core.body.message).toMatch(/batch-tracked/);

    const noBatch = await c.call("POST", `/api/fnb/purchase-orders/${po.id}/receive`, { date: "2026-10-01", lines: [{ poLineId: line(ids.yoghurt), quantity: 1 }] });
    expect(noBatch.body.message).toMatch(/batch code/);
    const expired = await c.call("POST", `/api/fnb/purchase-orders/${po.id}/receive`, {
      date: "2026-10-01", lines: [{ poLineId: line(ids.yoghurt), quantity: 1, batchCode: "OLD", expiry: "2026-09-30" }],
    });
    expect(expired.body.message).toMatch(/past its use-by/);

    const grn = await c.ok("POST", `/api/fnb/purchase-orders/${po.id}/receive`, {
      date: "2026-10-01",
      lines: [
        { poLineId: line(ids.yoghurt), quantity: 80, batchCode: "Y-A", expiry: "2026-10-28" },
        { poLineId: line(ids.yoghurt), quantity: 120, batchCode: "Y-B", expiry: "2026-11-15" },
        { poLineId: line(ids.oil), quantity: 50, batchCode: "OL-77" },
        { poLineId: line(ids.napkin), quantity: 20 },
      ],
    });
    expect(grn.number).toMatch(/^GRN-/);
    expect(grn.batches.map((b: { code: string; expiry: string }) => [b.code, b.expiry])).toEqual([
      ["Y-A", "2026-10-28"], ["Y-B", "2026-11-15"], ["OL-77", "2027-10-01"],
    ]);
    for (const b of grn.batches) batch[b.code] = b.batchId;
    await expectBooksIntact(c);
  });

  it("invoices first expiry first out, honouring a customer's minimum life", async () => {
    const preview = await c.ok("POST", "/api/fnb/allocation-preview", { productId: ids.yoghurt, quantity: 100, date: "2026-10-20" });
    expect(preview.allocation.map((a: { code: string; quantity: string }) => [a.code, a.quantity])).toEqual([["Y-A", "80"], ["Y-B", "20"]]);

    const inv = await c.ok("POST", "/api/fnb/sales-invoices", {
      customerId: ids.cafe, date: "2026-10-20",
      lines: [{ productId: ids.yoghurt, quantity: 50, unitPrice: "2.40" }, { productId: ids.napkin, quantity: 5, unitPrice: "1.50" }],
    });
    expect(inv.allocations.map((a: { code: string; quantity: string; line: number }) => [a.line, a.code, a.quantity])).toEqual([[1, "Y-A", "50"]]);

    // The school needs 10 days' life: Y-A (8 days left) is skipped.
    const school = await c.ok("POST", "/api/fnb/sales-invoices", {
      customerId: ids.school, date: "2026-10-20", lines: [{ productId: ids.yoghurt, quantity: 40, unitPrice: "2.40" }],
    });
    expect(school.allocations.map((a: { code: string }) => a.code)).toEqual(["Y-B"]);

    // A second line for the same product on one invoice uses what is left after the first line.
    const two = await c.ok("POST", "/api/fnb/sales-invoices", {
      customerId: ids.cafe, date: "2026-10-21",
      lines: [{ productId: ids.yoghurt, quantity: 20, unitPrice: "2.40" }, { productId: ids.yoghurt, quantity: 15, unitPrice: "2.40" }],
    });
    expect(two.allocations.map((a: { line: number; code: string; quantity: string }) => [a.line, a.code, a.quantity]))
      .toEqual([[1, "Y-A", "20"], [2, "Y-A", "10"], [2, "Y-B", "5"]]);

    const batches = await c.ok("GET", `/api/fnb/sales-invoices/${inv.id}/batches`);
    expect(batches).toHaveLength(1);
    expect((await c.call("POST", "/api/sales-invoices", {
      customerId: ids.cafe, date: "2026-10-21", lines: [{ productId: ids.yoghurt, quantity: 1, unitPrice: "2.40" }],
    })).status).toBe(422);
    await expectBooksIntact(c);
  });

  it("never sells yoghurt past its use-by date", async () => {
    // On 16 Nov, Y-B (use-by 15 Nov) is out of date and nothing else is left.
    const r = await c.call("POST", "/api/fnb/sales-invoices", {
      customerId: ids.cafe, date: "2026-11-16", lines: [{ productId: ids.yoghurt, quantity: 1, unitPrice: "2.40" }],
    });
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/Batch Y-B is past its use-by date/);
    const manual = await c.call("POST", "/api/fnb/sales-invoices", {
      customerId: ids.cafe, date: "2026-11-16",
      lines: [{ productId: ids.yoghurt, quantity: 1, unitPrice: "2.40", batches: [{ batchId: batch["Y-B"], quantity: 1 }] }],
    });
    expect(manual.status).toBe(422);
    // Best-before oil past its date can still be sold, and the allocation says so.
    const oil = await c.ok("POST", "/api/fnb/allocation-preview", { productId: ids.oil, quantity: 1, date: "2027-11-01" });
    expect(oil.allocation[0]).toMatchObject({ code: "OL-77", pastBestBefore: true });
  });

  it("returns goods into the batch they came from and traces a recall", async () => {
    const cn = await c.ok("POST", "/api/fnb/credit-notes", {
      customerId: ids.school, date: "2026-10-22",
      lines: [{ productId: ids.yoghurt, quantity: 5, unitPrice: "2.40", returnToStock: true, batches: [{ batchId: batch["Y-B"], quantity: 5 }] }],
    });
    expect(cn.number).toMatch(/^CN-/);
    const wrong = await c.call("POST", "/api/fnb/credit-notes", {
      customerId: ids.school, date: "2026-10-22",
      lines: [{ productId: ids.yoghurt, quantity: 1, unitPrice: "2.40", returnToStock: true, batches: [{ batchId: batch["Y-A"], quantity: 1 }] }],
    });
    expect(wrong.body.message).toMatch(/supplied to this customer/);

    const trace = await c.ok("GET", `/api/fnb/recall-trace?sku=YOG-500&code=Y-B`);
    expect(trace.supplier).toMatchObject({ name: "Dairy Co-op Ltd", receipt: expect.stringMatching(/^GRN-/), purchaseOrder: expect.stringMatching(/^PO-/) });
    expect(trace.totals).toEqual({ received: "120", dispatched: "45", returned: "5", writtenOff: "0", onHand: "80" });
    expect(trace.customers.map((x: { name: string; quantity: string; documents: string[] }) => [x.name, x.quantity, x.documents.length]))
      .toEqual([["Riverside School", "35", 2], ["Harbour Café", "5", 1]]);
    expect(trace.batch.status).toBeDefined();
    await expectBooksIntact(c);
  });

  it("reports expiry and writes off the expired batch through the ledger", async () => {
    const report = await c.ok("GET", "/api/fnb/reports/expiry?asAt=2026-11-16");
    const yb = report.rows.find((r: { code: string }) => r.code === "Y-B");
    expect(yb).toMatchObject({ status: "expired", blocked: true, daysLeft: -1, value: "96.00" });
    expect(Number(yb.quantity)).toBe(80);
    expect(report.summary.expired).toEqual({ batches: 1, value: "96.00" });
    expect(report.rows.find((r: { code: string }) => r.code === "Y-A")).toBeUndefined(); // sold out

    const wo = await c.ok("POST", `/api/fnb/batches/${batch["Y-B"]}/write-off`, { date: "2026-11-16", quantity: 80, reason: "Past use-by" });
    expect(wo.value).toBe("96.00"); // 80 × £1.20 weighted average
    const accounts = await c.ok("GET", "/api/accounts") as { code: string; balance: string }[];
    expect(Number(accounts.find((a) => a.code === "5050")!.balance)).toBe(96);
    const again = await c.call("POST", `/api/fnb/batches/${batch["Y-B"]}/write-off`, { date: "2026-11-16", quantity: 1, reason: "again" });
    expect(again.status).toBe(422);
    const after = await c.ok("GET", "/api/fnb/reports/expiry?asAt=2026-11-16");
    expect(after.summary.expired.batches).toBe(0);
    expect((await c.ok("GET", `/api/fnb/batches/${batch["Y-B"]}`)).totals).toMatchObject({ writtenOff: "80", onHand: "0" });
    await expectBooksIntact(c);
  });

  it("keeps batches append-only and private to each tenant", async () => {
    const tenantRows = await db.query<{ id: string }>("SELECT id FROM tenants");
    const other = newId();
    await db.system((tx) => tx.query("INSERT INTO tenants (id, name) VALUES ($1, 'Other Ltd')", [other]));
    expect(await db.tenant(other, (tx) => tx.query("SELECT * FROM fnb_batches"))).toHaveLength(0);
    const mine = tenantRows[0]!.id;
    await expect(db.tenant(mine, (tx) => tx.query("UPDATE fnb_batch_movements SET quantity = 1"))).rejects.toThrow();
    await expect(db.system((tx) => tx.query("DELETE FROM fnb_batch_movements"))).rejects.toThrow(/append-only/);
    await expect(db.tenant(mine, (tx) => tx.query("UPDATE fnb_batches SET expiry = '2030-01-01'"))).rejects.toThrow();
  });
});
