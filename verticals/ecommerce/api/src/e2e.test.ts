import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "@softilo/api/server";
import { createPgliteDatabase, type Database } from "@softilo/db";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateEcommerce, registerEcommerce } from "./module.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "shopify");
const load = (name: string) => JSON.parse(readFileSync(join(fixtures, name), "utf8"));

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
}

beforeAll(async () => {
  db = await createPgliteDatabase();
  await migrateEcommerce(db);
  app = await buildServer(db, {}, [registerEcommerce]);
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe("e-commerce vertical slice", () => {
  const c = client();
  const ids: Record<string, string> = {};

  it("signs up a brand and buys in stock through the core", async () => {
    await c.ok("POST", "/api/auth/signup", {
      companyName: "Wick & Ember Ltd", vatNumber: "GB123456789", name: "Hannah Reid",
      email: "hannah@wickandember.example", password: "correct horse battery",
    });
    const supplier = (await c.ok("POST", "/api/contacts", { kind: "supplier", name: "Peak Wax Supplies Ltd" })).id;
    ids.candle = (await c.ok("POST", "/api/products", { sku: "CANDLE-FIG", name: "Fig & cedar candle", salesPrice: "22" })).id;
    ids.diffuser = (await c.ok("POST", "/api/products", { sku: "DIFF-OAK", name: "Oakmoss reed diffuser", salesPrice: "18" })).id;
    const po = await c.ok("POST", "/api/purchase-orders", {
      supplierId: supplier, date: "2026-08-20",
      lines: [
        { productId: ids.candle, quantity: 50, unitPrice: "8.00", vatCode: "S20" },
        { productId: ids.diffuser, quantity: 30, unitPrice: "5.00", vatCode: "S20" },
      ],
    });
    await c.ok("POST", `/api/purchase-orders/${po.id}/approve`);
    const detail = await c.ok("GET", `/api/purchase-orders/${po.id}`);
    await c.ok("POST", `/api/purchase-orders/${po.id}/receive`, {
      date: "2026-08-28", lines: detail.lines.map((l: { id: string; quantity: string }) => ({ poLineId: l.id, quantity: l.quantity })),
    });
    expect(await balances(c)).toMatchObject({ "1001": "550.00" });
  });

  it("connects a Shopify store as a sales channel", async () => {
    ids.channel = (await c.ok("POST", "/api/ecommerce/channels", { kind: "shopify", name: "Wick & Ember Shopify" })).id;
    const [ch] = await c.ok("GET", "/api/ecommerce/channels");
    expect(ch).toMatchObject({ name: "Wick & Ember Shopify", fee_vat_code: "RC20", vat_treatment: "seller" });
    const dup = await c.call("POST", "/api/ecommerce/channels", { kind: "shopify", name: "Wick & Ember Shopify" });
    expect(dup.status).toBe(422);
  });

  it("imports Shopify orders as sales invoices that issue stock", async () => {
    const r = await c.ok("POST", `/api/ecommerce/channels/${ids.channel}/orders/import`, { payload: load("orders-2026-09.json") });
    expect(r.imported.map((o: { orderNumber: string }) => o.orderNumber)).toEqual(["#1001", "#1002", "#1003"]);
    expect(r.imported.map((o: { total: string }) => o.total)).toEqual(["43.59", "18.00", "40.00"]);
    expect(r.skipped).toEqual([
      { orderNumber: "#1004", reason: "SKU MUG-001 is not set up as a product" },
      { orderNumber: "#1005", reason: "Payment is pending" },
    ]);
    // Debtors = what Shopify owes us; sales and delivery net of VAT; 3 candles at £8 and 2 diffusers at £5 issued.
    expect(await balances(c)).toMatchObject({
      "1100": "101.59", "4000": "-81.33", "4900": "-3.32", "2200": "-16.94", "5000": "34.00", "1001": "516.00",
    });
    await expectBooksIntact(c);
  });

  it("skips orders already imported", async () => {
    const r = await c.ok("POST", `/api/ecommerce/channels/${ids.channel}/orders/import`, { payload: load("orders-2026-09.json") });
    expect(r.imported).toEqual([]);
    expect(r.skipped.filter((s: { reason: string }) => s.reason === "Already imported")).toHaveLength(3);
  });

  it("refuses a file that is not in Shopify's format", async () => {
    const r = await c.call("POST", `/api/ecommerce/channels/${ids.channel}/orders/import`, { payload: { rows: [] } });
    expect(r.status).toBe(422);
  });

  it("shows orders with margin", async () => {
    const orders = await c.ok("GET", "/api/ecommerce/orders") as { order_number: string; id: string; net: string; cost: string }[];
    expect(orders).toHaveLength(3);
    for (const o of orders) ids[o.order_number] = o.id;
    const o1 = orders.find((o) => o.order_number === "#1001")!;
    expect([o1.net, o1.cost]).toEqual(["36.32", "16.00"]);
  });

  it("will not reconcile a payout whose refund has no return recorded", async () => {
    const preview = await c.ok("POST", `/api/ecommerce/channels/${ids.channel}/payouts/preview`, { payload: load("payout-2026-09-08.json") });
    expect(preview.split).toMatchObject({ sales: "101.59", refunds: "18.00", feesGross: "2.27", feesVat: "0.45", reserves: "-5.00", reconciled: true });
    expect(preview.problems).toEqual(["#1002: refund of 18.00 has no matching return (record the return first)"]);
    const r = await c.call("POST", `/api/ecommerce/channels/${ids.channel}/payouts`, { payload: load("payout-2026-09-08.json") });
    expect(r.status).toBe(422);
  });

  it("records returns: a damaged diffuser written off, a candle restocked", async () => {
    const o2 = await c.ok("GET", `/api/ecommerce/orders/${ids["#1002"]}`);
    const r2 = await c.ok("POST", `/api/ecommerce/orders/${ids["#1002"]}/returns`, {
      receivedDate: "2026-09-06", reason: "Arrived broken",
      lines: [{ invoiceLineId: o2.lines[0].id, quantity: 1, disposition: "write_off" }],
    });
    expect(r2).toMatchObject({ refund: "18.00", refundDueBy: "2026-09-20" });

    const o1 = await c.ok("GET", `/api/ecommerce/orders/${ids["#1001"]}`);
    const candle = o1.lines.find((l: { sku: string | null }) => l.sku === "CANDLE-FIG");
    const tooMany = await c.call("POST", `/api/ecommerce/orders/${ids["#1001"]}/returns`, {
      receivedDate: "2026-09-06", lines: [{ invoiceLineId: candle.id, quantity: 3, disposition: "restock" }],
    });
    expect(tooMany.status).toBe(422);
    const r1 = await c.ok("POST", `/api/ecommerce/orders/${ids["#1001"]}/returns`, {
      receivedDate: "2026-09-06", reason: "Changed mind",
      lines: [{ invoiceLineId: candle.id, quantity: 1, disposition: "restock" }],
    });
    expect(r1.refund).toBe("19.80");

    expect(await balances(c)).toMatchObject({
      "1100": "63.79", "1001": "524.00", "5000": "21.00", "5300": "5.00", "2200": "-10.64",
    });
    const returns = await c.ok("GET", "/api/ecommerce/returns");
    expect(returns).toHaveLength(2);
    await expectBooksIntact(c);
  });

  it("reconciles the Shopify Payments payout into sales, refunds, fees, VAT and reserves", async () => {
    const r = await c.ok("POST", `/api/ecommerce/channels/${ids.channel}/payouts`, { payload: load("payout-2026-09-08.json") });
    expect(r.split).toMatchObject({ amount: "76.32", feesNet: "2.27", feesVat: "0.45", feeVatCode: "RC20" });
    // Shopify still owes the £19.80 refund on #1001 (it will be netted off a later payout).
    expect(await balances(c)).toMatchObject({
      "1200": "76.32", "1100": "-19.80", "6100": "2.27", "1160": "5.00", "2201": "0.45", "2200": "-11.09",
    });
    const payout = await c.ok("GET", `/api/ecommerce/payouts/${r.id}`);
    expect(payout.lines).toHaveLength(8);
    const returns = await c.ok("GET", "/api/ecommerce/returns") as { order_number: string; refunded: boolean }[];
    expect(returns.find((x) => x.order_number === "#1002")!.refunded).toBe(true);
    expect(returns.find((x) => x.order_number === "#1001")!.refunded).toBe(false);
    // Figures after returns: Shopify will net the open £19.80 refund off its next payout.
    expect(await c.ok("GET", "/api/ecommerce/summary")).toMatchObject({ awaiting_payout: "-19.80", net_sales: "53.15", cost: "26.00", margin: "27.15" });
    const o1 = (await c.ok("GET", "/api/ecommerce/orders") as { order_number: string; net: string; cost: string; outstanding: string }[])
      .find((o) => o.order_number === "#1001")!;
    expect([o1.net, o1.cost, o1.outstanding]).toEqual(["19.82", "8.00", "-19.80"]);
    await expectBooksIntact(c);
  });

  it("refuses the same payout twice, and a payout that doesn't add up", async () => {
    const again = await c.call("POST", `/api/ecommerce/channels/${ids.channel}/payouts`, { payload: load("payout-2026-09-08.json") });
    expect(again.status).toBe(422);
    expect(again.body.message).toMatch(/already been imported/);
    const bad = load("payout-2026-09-08.json");
    bad.payout.id = 88002;
    bad.payout.amount = "80.00";
    const r = await c.call("POST", `/api/ecommerce/channels/${ids.channel}/payouts`, { payload: bad });
    expect(r.status).toBe(422);
  });

  it("puts channel sales, refunds and fee VAT on the VAT return", async () => {
    const vat = await db.tenant((await c.ok("GET", "/api/auth/me")).tenant_id, (tx) => tx.query<{ direction: string; vat_code: string; net: string; vat: string }>(
      "SELECT direction, vat_code, sum(net) AS net, sum(vat) AS vat FROM vat_entries GROUP BY 1, 2 ORDER BY 1, 2"));
    // Sales 84.65 net / 16.94 VAT, less returns 31.50 / 6.30.
    expect(vat).toContainEqual({ direction: "sales", vat_code: "S20", net: "53.15", vat: "10.64" });
    expect(vat).toContainEqual({ direction: "purchase", vat_code: "RC20", net: "2.27", vat: "0.45" });
  });

  it("keeps each brand's channels private", async () => {
    const other = client();
    await other.ok("POST", "/api/auth/signup", {
      companyName: "Other Brand Ltd", name: "Sam Lee", email: "sam@other.example", password: "correct horse battery",
    });
    expect(await other.ok("GET", "/api/ecommerce/channels")).toEqual([]);
    expect(await other.ok("GET", "/api/ecommerce/orders")).toEqual([]);
    expect((await other.call("GET", `/api/ecommerce/orders/${ids["#1001"]}`)).status).toBe(404);
  });
});
