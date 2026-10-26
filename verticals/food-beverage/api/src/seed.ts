/**
 * Demo data for the food & beverage edition: a chilled and ambient food wholesaler with dated batches.
 * Runs through the real API, so every posting goes through the same rules as production.
 * Dates are relative to today, so the expiry report always has something to show.
 *
 *   pnpm --filter @softilo/fnb-api seed     (uses DATABASE_URL, or the embedded dev database in .data/pglite-fnb)
 *
 * Demo sign-in (development only):
 *   email:    demo-fnb@softilo.test
 *   password: softilo-demo-2026
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { buildServer } from "@softilo/api/server";
import { createDatabase } from "@softilo/db";
import type { InjectOptions } from "fastify";
import { migrateFoodBeverage } from "./migrate.js";
import { registerFoodBeverage } from "./module.js";

const EMAIL = "demo-fnb@softilo.test";
const PASSWORD = "softilo-demo-2026";

const url = process.env.DATABASE_URL || undefined;
const dataDir = url ? undefined : resolve(process.env.PGLITE_DIR ?? "../../../.data/pglite-fnb");
if (dataDir) mkdirSync(dataDir, { recursive: true });
const db = await createDatabase({ url, dataDir });
await migrateFoodBeverage(db);
const app = await buildServer(db, {}, [registerFoodBeverage]);

let cookie = "";
async function api<T = any>(method: InjectOptions["method"], path: string, body?: unknown): Promise<T> {
  const res = await app.inject({ method, url: path, payload: body as InjectOptions["payload"], headers: cookie ? { cookie } : {} });
  const set = res.headers["set-cookie"];
  if (set) cookie = (Array.isArray(set) ? set[0]! : set).split(";")[0]!;
  if (res.statusCode >= 400) throw new Error(`${method} ${path} → ${res.statusCode}: ${res.body}`);
  return res.body ? res.json() : (undefined as T);
}

const day = (offset: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

const [existing] = await db.query("SELECT 1 FROM users WHERE email = $1", [EMAIL]);
if (existing) {
  console.log("Demo company already exists; nothing to do.");
} else {
  await api("POST", "/api/auth/signup", {
    companyName: "Severn Fine Foods Ltd", companyNumber: "09876543", vatNumber: "GB246813579",
    name: "Tom Hughes", email: EMAIL, password: PASSWORD,
  });
  const dairy = (await api("POST", "/api/contacts", { kind: "supplier", name: "Vale Dairy Co-operative", email: "orders@valedairy.example" })).id;
  const deli = (await api("POST", "/api/contacts", { kind: "supplier", name: "Mediterranea Imports Ltd", email: "sales@mediterranea.example" })).id;
  const cafe = (await api("POST", "/api/contacts", { kind: "customer", name: "Harbour Café", email: "kitchen@harbourcafe.example", phone: "0117 496 0123" })).id;
  const school = (await api("POST", "/api/contacts", { kind: "customer", name: "Riverside Academy Catering", email: "catering@riverside.example" })).id;
  const deliShop = (await api("POST", "/api/contacts", { kind: "customer", name: "Clifton Deli", email: "hello@cliftondeli.example" })).id;

  const product = async (sku: string, name: string, price: string, vat: string, settings?: object) => {
    const id = (await api("POST", "/api/products", { sku, name, salesPrice: price, salesVatCode: vat, purchaseVatCode: vat })).id as string;
    if (settings) await api("PUT", `/api/fnb/products/${id}/settings`, settings);
    return id;
  };
  const yoghurt = await product("YOG-500", "Greek yoghurt 500g", "2.40", "Z0", { dateType: "use_by", storage: "chilled", allergens: ["milk"] });
  const cheddar = await product("CHD-2.5", "Mature cheddar block 2.5kg", "18.50", "Z0", { dateType: "use_by", storage: "chilled", allergens: ["milk"], shelfLifeDays: 60 });
  const pesto = await product("PES-190", "Basil pesto 190g", "3.10", "Z0", { dateType: "best_before", allergens: ["milk", "nuts"], shelfLifeDays: 270 });
  const oil = await product("OIL-1L", "Extra virgin olive oil 1L", "7.20", "Z0", { dateType: "best_before", shelfLifeDays: 540 });
  const crisps = await product("CRS-40", "Sea salt crisps 40g x 24", "9.60", "S20", { dateType: "best_before", shelfLifeDays: 120 });
  await product("NAP-100", "Paper napkins x100", "1.50", "S20");
  await api("PUT", `/api/fnb/customers/${school}/settings`, { minLifeDays: 5 });

  const receive = async (supplierId: string, date: string, lines: { productId: string; quantity: number; unitPrice: string; batches: { code: string; quantity: number; expiry?: string }[] }[]) => {
    const po = await api("POST", "/api/purchase-orders", { supplierId, date, lines: lines.map(({ batches: _b, ...l }) => l) });
    await api("POST", `/api/purchase-orders/${po.id}/approve`);
    const detail = await api("GET", `/api/purchase-orders/${po.id}`);
    await api("POST", `/api/fnb/purchase-orders/${po.id}/receive`, {
      date,
      lines: lines.flatMap((l) => {
        const poLineId = detail.lines.find((x: { product_id: string }) => x.product_id === l.productId).id;
        return l.batches.map((b) => ({ poLineId, quantity: b.quantity, batchCode: b.code, expiry: b.expiry }));
      }),
    });
  };
  await receive(dairy, day(-20), [
    { productId: yoghurt, quantity: 240, unitPrice: "1.20", batches: [
      { code: "VD2610A", quantity: 96, expiry: day(-1) }, { code: "VD2610B", quantity: 144, expiry: day(3) }] },
    { productId: cheddar, quantity: 40, unitPrice: "11.40", batches: [{ code: "CH-4471", quantity: 40, expiry: day(38) }] },
  ]);
  await receive(deli, day(-14), [
    { productId: pesto, quantity: 120, unitPrice: "1.45", batches: [{ code: "L25-188", quantity: 120, expiry: day(-6) }] },
    { productId: oil, quantity: 60, unitPrice: "4.10", batches: [{ code: "OL-0925", quantity: 60 }] },
    { productId: crisps, quantity: 30, unitPrice: "5.20", batches: [{ code: "CR31", quantity: 30 }] },
  ]);
  await receive(dairy, day(-3), [
    { productId: yoghurt, quantity: 192, unitPrice: "1.22", batches: [{ code: "VD2611C", quantity: 192, expiry: day(12) }] },
  ]);

  const invoice = async (customerId: string, date: string, lines: [string, number, string][]) => api("POST", "/api/fnb/sales-invoices", {
    customerId, date, lines: lines.map(([productId, quantity, unitPrice]) => ({ productId, quantity, unitPrice })),
  });
  await invoice(cafe, day(-18), [[yoghurt, 48, "2.40"], [oil, 6, "7.20"]]);
  await invoice(school, day(-15), [[yoghurt, 36, "2.30"], [cheddar, 4, "18.50"]]);
  await invoice(deliShop, day(-12), [[pesto, 24, "3.10"], [oil, 12, "7.00"], [crisps, 5, "9.60"]]);
  await invoice(cafe, day(-8), [[yoghurt, 60, "2.40"], [cheddar, 2, "18.50"], [pesto, 12, "3.10"]]);
  await invoice(school, day(-2), [[yoghurt, 72, "2.30"]]);
  await invoice(deliShop, day(-1), [[cheddar, 3, "18.50"], [pesto, 6, "3.10"]]);
  console.log(`Seeded Severn Fine Foods Ltd. Sign in as ${EMAIL} / ${PASSWORD}`);
}
await app.close();
await db.close();
