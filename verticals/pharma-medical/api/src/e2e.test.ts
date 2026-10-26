import { createPgliteDatabase, newId, type Database } from "@softilo/db";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPharmaServer, migratePharma } from "./server.js";

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

async function expectBooksIntact(c: ReturnType<typeof client>) {
  expect((await c.ok("GET", "/api/reports/trial-balance")).balanced).toBe(true);
  expect(await c.ok("GET", "/api/reports/integrity")).toMatchObject({ allReconciled: true });
  expect(await c.ok("GET", "/api/pharma/integrity")).toMatchObject({ allReconciled: true });
}

beforeAll(async () => {
  db = await createPgliteDatabase();
  await migratePharma(db);
  app = await buildPharmaServer(db);
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe("pharmaceutical wholesale slice", () => {
  const c = client();
  const ids: Record<string, string> = {};
  const batchId = async (batchNumber: string) =>
    ((await c.ok("GET", `/api/pharma/batches?batchNumber=${batchNumber}`)) as { id: string; batch_number: string }[])
      .find((b) => b.batch_number === batchNumber)!.id;

  it("sets up a wholesaler with customers, licences and classified products", async () => {
    expect((await c.call("POST", "/api/auth/signup", {
      companyName: "Mersey Pharma Distribution Ltd", companyNumber: "09876543", vatNumber: "GB223344556",
      name: "Aisha Okafor", email: "aisha@mersey.example", password: "correct horse battery",
    })).status).toBe(201);
    ids.me = (await c.ok("GET", "/api/auth/me")).id ?? (await c.ok("GET", "/api/pharma/users"))[0].id;

    ids.supplier = (await c.ok("POST", "/api/contacts", { kind: "supplier", name: "Northern Generics plc" })).id;
    ids.pharmacy = (await c.ok("POST", "/api/contacts", { kind: "customer", name: "High Street Pharmacy Ltd" })).id;
    ids.clinic = (await c.ok("POST", "/api/contacts", { kind: "customer", name: "Glow Aesthetics Clinic" })).id;
    ids.wholesaler = (await c.ok("POST", "/api/contacts", { kind: "customer", name: "Lapsed Wholesale Ltd" })).id;

    ids.amox = (await c.ok("POST", "/api/products", { sku: "AMOX-500-21", name: "Amoxicillin 500mg capsules x21", salesPrice: "2.10" })).id;
    ids.gloves = (await c.ok("POST", "/api/products", { sku: "GLV-NIT-M", name: "Nitrile gloves medium x100", salesPrice: "4.50" })).id;
    await c.ok("PUT", `/api/pharma/products/${ids.amox}`, { kind: "medicine", legalCategory: "POM", storage: "ambient", licenceNumber: "PL 12345/0001" });
    await c.ok("PUT", `/api/pharma/products/${ids.gloves}`, { kind: "device", batchTracked: false, deviceMark: "UKCA" });
    expect((await c.call("PUT", `/api/pharma/products/${ids.amox}`, { kind: "medicine" })).status).toBe(422);

    await c.ok("POST", `/api/pharma/customers/${ids.pharmacy}/licences`, {
      type: "gphc_pharmacy", number: "1098765", verifiedOn: "2026-10-01", verificationSource: "GPhC register of premises",
    });
    await c.ok("POST", `/api/pharma/customers/${ids.wholesaler}/licences`, {
      type: "wda_h", number: "WDA(H) 55555", expiresOn: "2026-06-30", verifiedOn: "2026-01-10", verificationSource: "MHRA register",
    });
    expect((await c.call("POST", `/api/pharma/customers/${ids.clinic}/licences`, { type: "wda_h", number: "X", verifiedOn: "2026-10-01" })).status).toBe(422);
  });

  it("receives batches into quarantine through goods in, and refuses the core receipt route", async () => {
    const po = await c.ok("POST", "/api/purchase-orders", {
      supplierId: ids.supplier, date: "2026-10-01",
      lines: [{ productId: ids.amox, quantity: 350, unitPrice: "1.00", vatCode: "S20" }, { productId: ids.gloves, quantity: 20, unitPrice: "2.00" }],
    });
    ids.po = po.id;
    await c.ok("POST", `/api/purchase-orders/${po.id}/approve`);
    const detail = await c.ok("GET", `/api/purchase-orders/${po.id}`);
    const [amoxLine, gloveLine] = detail.lines as { id: string }[];

    const core = await c.call("POST", `/api/purchase-orders/${po.id}/receive`, { date: "2026-10-20", lines: [{ poLineId: amoxLine!.id, quantity: 10 }] });
    expect(core.status).toBe(422);
    expect(core.body.message).toMatch(/batch-tracked/);

    const missing = await c.call("POST", "/api/pharma/receipts", { poId: po.id, date: "2026-10-20", lines: [{ poLineId: amoxLine!.id, quantity: 10 }] });
    expect(missing.status).toBe(422);
    const expired = await c.call("POST", "/api/pharma/receipts", {
      poId: po.id, date: "2026-10-20", lines: [{ poLineId: amoxLine!.id, quantity: 10, batchNumber: "OLD1", expiry: "2026-09" }],
    });
    expect(expired.body.message).toMatch(/expired on 2026-09-30/);

    const grn = await c.ok("POST", "/api/pharma/receipts", {
      poId: po.id, date: "2026-10-20",
      lines: [
        { poLineId: amoxLine!.id, quantity: 50, batchNumber: "a0", expiry: "2029-01" },
        { poLineId: amoxLine!.id, quantity: 100, batchNumber: "A1", expiry: "2029-06-30" },
        { poLineId: amoxLine!.id, quantity: 200, batchNumber: "A2", expiry: "2030-12" },
        { poLineId: gloveLine!.id, quantity: 20 },
      ],
    });
    expect(grn.batches.map((b: { batchNumber: string }) => b.batchNumber)).toEqual(["A0", "A1", "A2"]);
    const batches = await c.ok("GET", "/api/pharma/batches") as { status: string; on_hand: string; expiry: string }[];
    expect(batches.map((b) => [b.status, Number(b.on_hand), b.expiry])).toEqual([
      ["quarantine", 50, "2029-01-31"], ["quarantine", 100, "2029-06-30"], ["quarantine", 200, "2030-12-31"],
    ]);
    await expectBooksIntact(c);
  });

  it("will not supply quarantined stock", async () => {
    const r = await c.call("POST", "/api/pharma/dispatches", {
      customerId: ids.pharmacy, date: "2026-11-01", lines: [{ productId: ids.amox, quantity: 10, unitPrice: "2.10" }],
    });
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/Only 0 released.*350 in quarantine/);
  });

  it("lets only a Responsible Person release, reject or recall", async () => {
    const a0 = await batchId("A0");
    const r = await c.call("POST", `/api/pharma/batches/${a0}/release`, {});
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/Responsible Person/);

    const users = await c.ok("GET", "/api/pharma/users") as { id: string }[];
    await c.ok("POST", "/api/pharma/responsible-persons", { userId: users[0]!.id, appointedOn: "2026-01-01" });
    expect((await c.ok("GET", "/api/pharma/me")).isResponsiblePerson).toBe(true);

    for (const b of ["A0", "A1", "A2"]) await c.ok("POST", `/api/pharma/batches/${await batchId(b)}/release`, {});
    expect((await c.call("POST", `/api/pharma/batches/${a0}/release`, {})).status).toBe(422);
    const detail = await c.ok("GET", `/api/pharma/batches/${a0}`);
    expect(detail.events.map((e: { action: string }) => e.action)).toEqual(["receive", "release"]);
    expect(detail.actions).toEqual(["quarantine", "recall"]);
  });

  it("checks the customer is entitled to receive POM medicines before supply", async () => {
    const preview = await c.ok("POST", "/api/pharma/allocation-preview", {
      customerId: ids.clinic, date: "2026-11-01", lines: [{ productId: ids.amox, quantity: 5 }, { productId: ids.gloves, quantity: 2 }],
    });
    expect(preview.ok).toBe(false);
    expect(preview.plan[0].error).toMatch(/no licence/);
    expect(preview.plan[1].error).toBeUndefined();

    for (const customerId of [ids.clinic, ids.wholesaler]) {
      const r = await c.call("POST", "/api/pharma/dispatches", {
        customerId, date: "2026-11-01", lines: [{ productId: ids.amox, quantity: 5, unitPrice: "2.10" }],
      });
      expect(r.status).toBe(422);
    }
    const lapsed = await c.call("POST", "/api/pharma/dispatches", {
      customerId: ids.wholesaler, date: "2026-11-01", lines: [{ productId: ids.amox, quantity: 5, unitPrice: "2.10" }],
    });
    expect(lapsed.body.message).toMatch(/expired on 2026-06-30/);
    // Devices need no licence and are not batch-tracked here, so the core invoice route still works for them.
    await c.ok("POST", "/api/sales-invoices", { customerId: ids.clinic, date: "2026-11-01", lines: [{ productId: ids.gloves, quantity: 2, unitPrice: "4.50" }] });
  });

  it("dispatches first-expiry-first-out and invoices through the core", async () => {
    const r = await c.ok("POST", "/api/pharma/dispatches", {
      customerId: ids.pharmacy, date: "2026-11-01", lines: [{ productId: ids.amox, quantity: 120, unitPrice: "2.10" }],
    });
    expect(r.allocations[0].batches.map((b: { batchNumber: string; quantity: string }) => [b.batchNumber, b.quantity])).toEqual([["A0", "50"], ["A1", "70"]]);
    const inv = await c.ok("GET", `/api/sales-invoices/${r.invoiceId}`);
    expect(inv.total).toBe("302.40"); // 120 × £2.10 + 20% VAT
    await expectBooksIntact(c);

    const core = await c.call("POST", "/api/sales-invoices", {
      customerId: ids.pharmacy, date: "2026-11-01", lines: [{ productId: ids.amox, quantity: 1, unitPrice: "2.10" }],
    });
    expect(core.status).toBe(422);
    expect(core.body.message).toMatch(/Dispatch/);
  });

  it("honours the customer's minimum remaining shelf life", async () => {
    await c.ok("PUT", `/api/pharma/customers/${ids.pharmacy}/profile`, { minShelfLifeDays: 1000 });
    // 2026-11-02 + 1000 days = 2029-07-30, so A1 (2029-06-30) is too short-dated for this customer.
    const r = await c.ok("POST", "/api/pharma/dispatches", {
      customerId: ids.pharmacy, date: "2026-11-02", lines: [{ productId: ids.amox, quantity: 40, unitPrice: "2.10" }],
    });
    expect(r.allocations[0].batches.map((b: { batchNumber: string }) => b.batchNumber)).toEqual(["A2"]);
    await c.ok("PUT", `/api/pharma/customers/${ids.pharmacy}/profile`, { minShelfLifeDays: 0 });
    await c.ok("POST", "/api/pharma/dispatches", {
      customerId: ids.pharmacy, date: "2026-11-03", lines: [{ productId: ids.amox, quantity: 10, unitPrice: "2.10" }],
    });
    await expectBooksIntact(c);
  });

  it("recalls a batch, traces every customer supplied, and blocks further supply", async () => {
    const t = await c.ok("POST", "/api/pharma/recalls", {
      productId: ids.amox, batchNumber: "a1", reason: "MHRA Class 2 medicines recall", reference: "EL(26)A/99",
    });
    expect(t).toMatchObject({ batchNumber: "A1", received: "100.0000", supplied: "80.0000", onHand: "20.0000", customers: 1 });
    expect(t.supplies.map((s: { customer_name: string; quantity: string }) => [s.customer_name, Number(s.quantity)]))
      .toEqual([["High Street Pharmacy Ltd", 70], ["High Street Pharmacy Ltd", 10]]);
    expect(t.lots[0].status).toBe("recalled");

    const after = await c.ok("POST", "/api/pharma/allocation-preview", {
      customerId: ids.pharmacy, date: "2026-11-04", lines: [{ productId: ids.amox, quantity: 160 }],
    });
    expect(after.plan[0].allocations.map((a: { batchNumber: string }) => a.batchNumber)).toEqual(["A2"]);
    expect(after.plan[0].allocations[0].quantity).toBe("160");
    expect(after.plan[0].error).toBeUndefined();
    const short = await c.ok("POST", "/api/pharma/allocation-preview", {
      customerId: ids.pharmacy, date: "2026-11-04", lines: [{ productId: ids.amox, quantity: 161 }],
    });
    expect(short.plan[0].error).toMatch(/Only 160 released.*20 rejected or recalled/);

    const a1 = await batchId("A1");
    expect((await c.call("POST", `/api/pharma/batches/${a1}/release`, {})).status).toBe(422);
    expect((await c.call("POST", `/api/pharma/batches/${await batchId("A2")}/quarantine`, {})).status).toBe(422); // needs a reason
    await expectBooksIntact(c);
  });

  it("enforces batch rules in the database as well as the API", async () => {
    const tenantId = ((await db.query<{ id: string }>("SELECT id FROM tenants"))[0]!).id;
    const [userId] = (await db.query<{ user_id: string }>("SELECT user_id FROM memberships")).map((r) => r.user_id);
    const a1 = await batchId("A1");
    await expect(db.tenant(tenantId, (tx) => tx.query(
      `INSERT INTO pharma_batch_movements (id, tenant_id, batch_id, date, kind, quantity, source_type, created_by)
       VALUES ($1,$2,$3,'2026-11-05','dispatch',-1,'test',$4)`, [newId(), tenantId, a1, userId]))).rejects.toThrow(/recalled/);
    await expect(db.tenant(tenantId, (tx) => tx.query("UPDATE pharma_batches SET status = 'released' WHERE id = $1", [a1])))
      .rejects.toThrow(/recorded decision/);
    await expect(db.tenant(tenantId, (tx) => tx.query("UPDATE pharma_batches SET expiry = '2031-01-01' WHERE id = $1", [a1])))
      .rejects.toThrow(/fixed/);
    await expect(db.tenant(tenantId, (tx) => tx.query("DELETE FROM pharma_batch_events"))).rejects.toThrow();
    // Another tenant sees none of these batches.
    const other = newId();
    await db.system((tx) => tx.query("INSERT INTO tenants (id, name) VALUES ($1, 'Other Ltd')", [other]));
    expect(await db.tenant(other, (tx) => tx.query("SELECT * FROM pharma_batches"))).toHaveLength(0);
  });
});
