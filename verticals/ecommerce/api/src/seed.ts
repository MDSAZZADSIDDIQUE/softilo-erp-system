/**
 * Demo data for the e-commerce edition: a candle brand selling through Shopify, with orders,
 * two returns and a reconciled Shopify Payments payout. Runs through the real API.
 *
 *   pnpm --filter @softilo-ecommerce/api seed     (uses DATABASE_URL, or the embedded dev database)
 *
 * Demo sign-in (development only):
 *   email:    demo@ecommerce.softilo.test
 *   password: softilo-demo-2026
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "@softilo/api/server";
import { createDatabase } from "@softilo/db";
import type { InjectOptions } from "fastify";
import { migrateEcommerce, registerEcommerce } from "./module.js";

export const DEMO_EMAIL = "demo@ecommerce.softilo.test";
export const DEMO_PASSWORD = "softilo-demo-2026";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "shopify");
const load = (name: string) => JSON.parse(readFileSync(join(fixtures, name), "utf8"));

const url = process.env.DATABASE_URL || undefined;
const dataDir = url ? undefined : resolve(process.env.PGLITE_DIR ?? "../../../.data/pglite-ecommerce");
if (dataDir) mkdirSync(dataDir, { recursive: true });
const db = await createDatabase({ url, dataDir });
await migrateEcommerce(db);
const app = await buildServer(db, {}, [registerEcommerce]);

let cookie = "";
async function api<T = any>(method: InjectOptions["method"], path: string, body?: unknown): Promise<T> {
  const res = await app.inject({ method, url: path, payload: body as InjectOptions["payload"], headers: cookie ? { cookie } : {} });
  const set = res.headers["set-cookie"];
  if (set) cookie = (Array.isArray(set) ? set[0]! : set).split(";")[0]!;
  if (res.statusCode >= 400) throw new Error(`${method} ${path} → ${res.statusCode}: ${res.body}`);
  return res.body ? res.json() : (undefined as T);
}

const [existing] = await db.query("SELECT 1 FROM users WHERE email = $1", [DEMO_EMAIL]);
if (existing) {
  console.log("Demo brand already exists; nothing to do.");
} else {
  await api("POST", "/api/auth/signup", {
    companyName: "Wick & Ember Ltd", companyNumber: "14567890", vatNumber: "GB123456789",
    name: "Hannah Reid", email: DEMO_EMAIL, password: DEMO_PASSWORD,
  });
  const supplier = (await api("POST", "/api/contacts", { kind: "supplier", name: "Peak Wax Supplies Ltd" })).id;
  const candle = (await api("POST", "/api/products", { sku: "CANDLE-FIG", name: "Fig & cedar candle", salesPrice: "22", reorderLevel: "20" })).id;
  const diffuser = (await api("POST", "/api/products", { sku: "DIFF-OAK", name: "Oakmoss reed diffuser", salesPrice: "18", reorderLevel: "10" })).id;
  const po = await api("POST", "/api/purchase-orders", {
    supplierId: supplier, date: "2026-08-20",
    lines: [
      { productId: candle, quantity: 50, unitPrice: "8.00", vatCode: "S20" },
      { productId: diffuser, quantity: 30, unitPrice: "5.00", vatCode: "S20" },
    ],
  });
  await api("POST", `/api/purchase-orders/${po.id}/approve`);
  const detail = await api("GET", `/api/purchase-orders/${po.id}`);
  await api("POST", `/api/purchase-orders/${po.id}/receive`, {
    date: "2026-08-28", lines: detail.lines.map((l: { id: string; quantity: string }) => ({ poLineId: l.id, quantity: l.quantity })),
  });
  const channel = (await api("POST", "/api/ecommerce/channels", { kind: "shopify", name: "Wick & Ember Shopify" })).id;
  await api("POST", `/api/ecommerce/channels/${channel}/orders/import`, { payload: load("orders-2026-09.json") });
  const orders = await api<{ id: string; order_number: string }[]>("GET", "/api/ecommerce/orders");
  const byNumber = Object.fromEntries(orders.map((o) => [o.order_number, o.id]));
  const o2 = await api("GET", `/api/ecommerce/orders/${byNumber["#1002"]}`);
  await api("POST", `/api/ecommerce/orders/${byNumber["#1002"]}/returns`, {
    receivedDate: "2026-09-06", reason: "Arrived broken", lines: [{ invoiceLineId: o2.lines[0].id, quantity: 1, disposition: "write_off" }],
  });
  const o1 = await api("GET", `/api/ecommerce/orders/${byNumber["#1001"]}`);
  await api("POST", `/api/ecommerce/orders/${byNumber["#1001"]}/returns`, {
    receivedDate: "2026-09-06", reason: "Changed mind", lines: [{ invoiceLineId: o1.lines[0].id, quantity: 1, disposition: "restock" }],
  });
  await api("POST", `/api/ecommerce/channels/${channel}/payouts`, { payload: load("payout-2026-09-08.json") });
  console.log(`Demo brand created. Sign in as ${DEMO_EMAIL}`);
}
await app.close();
await db.close();
