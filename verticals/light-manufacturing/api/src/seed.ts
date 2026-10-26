/**
 * Demo data for the light manufacturing edition: a UK lamp maker with a two-level product,
 * stock bought in, one finished sub-assembly order and one lamp order part-way through.
 * Runs through the real API so every posting goes through the same rules as production.
 *
 *   pnpm --filter @softilo/mfg-api seed
 *
 * Demo sign-in (development only):
 *   email:    maker@softilo.test
 *   password: softilo-maker-2026
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createDatabase } from "@softilo/db";
import type { InjectOptions } from "fastify";
import { buildEdition, migrateEdition } from "./edition.js";

export const DEMO_EMAIL = "maker@softilo.test";
export const DEMO_PASSWORD = "softilo-maker-2026";

const url = process.env.DATABASE_URL || undefined;
const dataDir = url ? undefined : resolve(process.env.PGLITE_DIR ?? "../../../.data/pglite-mfg");
if (dataDir) mkdirSync(dataDir, { recursive: true });
const db = await createDatabase({ url, dataDir });
await migrateEdition(db);
const app = await buildEdition(db);

let cookie = "";
async function api<T = any>(method: InjectOptions["method"], path: string, body?: unknown): Promise<T> {
  const res = await app.inject({ method, url: path, payload: body as InjectOptions["payload"], headers: cookie ? { cookie } : {} });
  const set = res.headers["set-cookie"];
  if (set) cookie = (Array.isArray(set) ? set[0]! : set).split(";")[0]!;
  if (res.statusCode >= 400) throw new Error(`${method} ${path} → ${res.statusCode}: ${res.body}`);
  return res.body ? res.json() : (undefined as T);
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const [existing] = await db.query("SELECT 1 FROM users WHERE email = $1", [DEMO_EMAIL]);
if (existing) {
  console.log("Demo maker already exists; nothing to do.");
} else {
  await api("POST", "/api/auth/signup", {
    companyName: "Sheffield Lamp Works Ltd", companyNumber: "15873621", vatNumber: "GB318274659",
    name: "Demo Maker", email: DEMO_EMAIL, password: DEMO_PASSWORD,
  });
  const product = async (sku: string, name: string, extra: object = {}) => (await api("POST", "/api/products", { sku, name, ...extra })).id as string;
  const lamp = await product("LAMP-01", "Anglepoise-style desk lamp", { salesPrice: "64.00" });
  const base = await product("BASE-01", "Weighted lamp base (sub-assembly)");
  const arm = await product("ARM-01", "Sprung steel arm");
  const shade = await product("SHADE-01", "Spun aluminium shade");
  const cable = await product("CAB-2M", "2 m braided flex with plug");
  const screw = await product("SCR-M4", "M4 stainless screw");
  const steel = await product("STL-SHEET", "Mild steel sheet", { uom: "kg" });

  const supplier = (await api("POST", "/api/contacts", { kind: "supplier", name: "Midlands Components Ltd", vatNumber: "GB123498765" })).id;
  const po = await api("POST", "/api/purchase-orders", {
    supplierId: supplier, date: daysAgo(30),
    lines: [
      { productId: arm, quantity: 60, unitPrice: "7.40", vatCode: "S20" },
      { productId: shade, quantity: 40, unitPrice: "6.50", vatCode: "S20" },
      { productId: cable, quantity: 80, unitPrice: "2.15", vatCode: "S20" },
      { productId: screw, quantity: 1000, unitPrice: "0.02", vatCode: "S20" },
      { productId: steel, quantity: 120, unitPrice: "3.10", vatCode: "S20" },
    ],
  });
  await api("POST", `/api/purchase-orders/${po.id}/approve`);
  const detail = await api("GET", `/api/purchase-orders/${po.id}`);
  await api("POST", `/api/purchase-orders/${po.id}/receive`, {
    date: daysAgo(25), lines: detail.lines.map((l: { id: string; quantity: string }) => ({ poLineId: l.id, quantity: l.quantity })),
  });
  // A second order for more shades, still to arrive.
  const po2 = await api("POST", "/api/purchase-orders", {
    supplierId: supplier, date: daysAgo(3), lines: [{ productId: shade, quantity: 30, unitPrice: "6.40", vatCode: "S20" }],
  });
  await api("POST", `/api/purchase-orders/${po2.id}/approve`);

  const centre = async (code: string, name: string, labourRate: string, overheadRate: string) =>
    (await api("POST", "/api/mfg/work-centres", { code, name, labourRate, overheadRate })).id as string;
  const fab = await centre("FAB", "Fabrication cell", "21.50", "28.00");
  const paint = await centre("PAINT", "Powder-coat line", "17.00", "35.00");
  const assy = await centre("ASSY", "Assembly and test bench", "18.00", "12.00");

  await api("POST", "/api/mfg/boms", {
    productId: base, outputQty: 10, notes: "Cut from 2 mm sheet, folded, ballast welded in.",
    lines: [{ componentId: screw, quantity: 40, wastagePct: 5 }, { componentId: steel, quantity: 12, wastagePct: 8 }],
    operations: [
      { workCentreId: fab, description: "Laser cut, fold and weld", setupHours: "1.5", runHoursPerUnit: "0.12" },
      { workCentreId: paint, description: "Powder coat, matt black", setupHours: "0.5", runHoursPerUnit: "0.05" },
    ],
  });
  await api("POST", "/api/mfg/boms", {
    productId: lamp,
    lines: [
      { componentId: base, quantity: 1 }, { componentId: arm, quantity: 1 }, { componentId: shade, quantity: 1 },
      { componentId: cable, quantity: 1 }, { componentId: screw, quantity: 6, wastagePct: 10 },
    ],
    operations: [{ workCentreId: assy, description: "Assemble, wire and PAT test", setupHours: "0.25", runHoursPerUnit: "0.3" }],
  });

  // Sub-assembly order, made and closed with one reject.
  const baseWo = await api("POST", "/api/mfg/works-orders", { productId: base, quantity: 30, release: true, dueDate: daysAgo(15) });
  await api("POST", `/api/mfg/works-orders/${baseWo.id}/issue`, { date: daysAgo(18) });
  await api("POST", `/api/mfg/works-orders/${baseWo.id}/labour`, { date: daysAgo(18), workCentreId: fab, hours: "5.1" });
  await api("POST", `/api/mfg/works-orders/${baseWo.id}/labour`, { date: daysAgo(17), workCentreId: paint, hours: "2" });
  await api("POST", `/api/mfg/works-orders/${baseWo.id}/complete`, { date: daysAgo(16), quantity: 29, scrapQuantity: 1 });

  // Lamp order part-way: materials issued for 20, time booked, 12 completed so far.
  const lampWo = await api("POST", "/api/mfg/works-orders", { productId: lamp, quantity: 40, release: true, dueDate: daysAgo(-7) });
  await api("POST", `/api/mfg/works-orders/${lampWo.id}/issue`, {
    date: daysAgo(10),
    lines: [
      { productId: base, quantity: 20 }, { productId: arm, quantity: 20 }, { productId: shade, quantity: 20 },
      { productId: cable, quantity: 20 }, { productId: screw, quantity: 132 },
    ],
  });
  await api("POST", `/api/mfg/works-orders/${lampWo.id}/labour`, { date: daysAgo(9), workCentreId: assy, hours: "4.5" });
  await api("POST", `/api/mfg/works-orders/${lampWo.id}/complete`, { date: daysAgo(8), quantity: 12 });

  // Another lamp order planned, which drives the shortage report.
  await api("POST", "/api/mfg/works-orders", { productId: lamp, quantity: 50, dueDate: daysAgo(-21), notes: "Trade show stock" });
  console.log(`Demo maker created. Sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}
await app.close();
await db.close();
