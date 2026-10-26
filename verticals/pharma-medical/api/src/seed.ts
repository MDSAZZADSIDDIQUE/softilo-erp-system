/**
 * Demo data for local development: a UK pharmaceutical wholesaler with batches in every GDP state.
 * Runs through the real API so every posting goes through the same rules as production.
 *
 *   pnpm --filter @softilo/pharma-api seed   (uses DATABASE_URL, or the embedded dev database in .data/pglite-pharma)
 *
 * Demo sign-in (development only):
 *   email:    rp@softilo-pharma.test
 *   password: softilo-pharma-2026
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createDatabase } from "@softilo/db";
import type { InjectOptions } from "fastify";
import { buildPharmaServer, migratePharma } from "./server.js";

export const DEMO_EMAIL = "rp@softilo-pharma.test";
export const DEMO_PASSWORD = "softilo-pharma-2026";

const url = process.env.DATABASE_URL || undefined;
const dataDir = url ? undefined : resolve(process.env.PGLITE_DIR ?? "../../../.data/pglite-pharma");
if (dataDir) mkdirSync(dataDir, { recursive: true });
const db = await createDatabase({ url, dataDir });
await migratePharma(db);
const app = await buildPharmaServer(db);

let cookie = "";
async function api<T = any>(method: InjectOptions["method"], path: string, body?: unknown): Promise<T> {
  const res = await app.inject({ method, url: path, payload: body as InjectOptions["payload"], headers: cookie ? { cookie } : {} });
  const set = res.headers["set-cookie"];
  if (set) cookie = (Array.isArray(set) ? set[0]! : set).split(";")[0]!;
  if (res.statusCode >= 400) throw new Error(`${method} ${path} → ${res.statusCode}: ${res.body}`);
  return res.body ? res.json() : (undefined as T);
}

const iso = (offsetDays: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

const [existing] = await db.query("SELECT 1 FROM users WHERE email = $1", [DEMO_EMAIL]);
if (existing) {
  console.log("Demo company already exists; nothing to do.");
} else {
  await api("POST", "/api/auth/signup", {
    companyName: "Mersey Pharma Distribution Ltd", companyNumber: "09876543", vatNumber: "GB223344556",
    name: "Aisha Okafor (RP)", email: DEMO_EMAIL, password: DEMO_PASSWORD,
  });
  const me = (await api<{ id: string }[]>("GET", "/api/pharma/users"))[0]!;
  await api("POST", "/api/pharma/responsible-persons", { userId: me.id, appointedOn: iso(-400) });

  const c = async (kind: string, name: string, extra: object = {}) => (await api("POST", "/api/contacts", { kind, name, ...extra })).id as string;
  const generics = await c("supplier", "Northern Generics plc", { vatNumber: "GB112233445" });
  const devices = await c("supplier", "Pennine Medical Devices Ltd");
  const pharmacy = await c("customer", "High Street Pharmacy Ltd", { email: "orders@highstreetpharmacy.example" });
  const trust = await c("customer", "Wirral Community NHS Trust", { email: "pharmacy.procurement@wirral.example" });
  const clinic = await c("customer", "Glow Aesthetics Clinic");

  const p = async (sku: string, name: string, salesPrice: string) => (await api("POST", "/api/products", { sku, name, salesPrice })).id as string;
  const amox = await p("AMOX-500-21", "Amoxicillin 500mg capsules x21", "2.10");
  const insulin = await p("INS-GLAR-5", "Insulin glargine 100u/ml pens x5", "34.50");
  const para = await p("PARA-500-16", "Paracetamol 500mg tablets x16", "0.45");
  const gloves = await p("GLV-NIT-M", "Nitrile examination gloves medium x100", "4.50");
  await api("PUT", `/api/pharma/products/${amox}`, { kind: "medicine", legalCategory: "POM", licenceNumber: "PL 12345/0001" });
  await api("PUT", `/api/pharma/products/${insulin}`, { kind: "medicine", legalCategory: "POM", storage: "cold_chain", licenceNumber: "PL 23456/0002" });
  await api("PUT", `/api/pharma/products/${para}`, { kind: "medicine", legalCategory: "GSL", licenceNumber: "PL 34567/0003" });
  await api("PUT", `/api/pharma/products/${gloves}`, { kind: "device", batchTracked: false, deviceMark: "UKCA" });

  await api("POST", `/api/pharma/customers/${pharmacy}/licences`, { type: "gphc_pharmacy", number: "1098765", verifiedOn: iso(-20), verificationSource: "GPhC register of premises" });
  await api("POST", `/api/pharma/customers/${trust}/licences`, { type: "nhs_trust", number: "RY7", verifiedOn: iso(-400), verificationSource: "NHS ODS" });
  await api("PUT", `/api/pharma/customers/${trust}/profile`, { minShelfLifeDays: 180 });

  const po = await api("POST", "/api/purchase-orders", { supplierId: generics, date: iso(-30), lines: [
    { productId: amox, quantity: 600, unitPrice: "0.95" }, { productId: insulin, quantity: 40, unitPrice: "26.00" }, { productId: para, quantity: 1000, unitPrice: "0.18" },
  ] });
  await api("POST", `/api/purchase-orders/${po.id}/approve`);
  const lines = (await api("GET", `/api/purchase-orders/${po.id}`)).lines as { id: string }[];
  const grn = await api("POST", "/api/pharma/receipts", { poId: po.id, date: iso(-25), lines: [
    { poLineId: lines[0]!.id, quantity: 200, batchNumber: "AMX2401", expiry: iso(75).slice(0, 7) },
    { poLineId: lines[0]!.id, quantity: 400, batchNumber: "AMX2512", expiry: iso(800) },
    { poLineId: lines[1]!.id, quantity: 40, batchNumber: "GL7781", expiry: iso(300) },
    { poLineId: lines[2]!.id, quantity: 1000, batchNumber: "PC0099", expiry: iso(1000) },
  ] });
  for (const b of grn.batches.slice(0, 3)) await api("POST", `/api/pharma/batches/${b.id}/release`, {});

  await api("POST", "/api/pharma/dispatches", { customerId: pharmacy, date: iso(-10), lines: [{ productId: amox, quantity: 150, unitPrice: "2.10" }] });
  await api("POST", "/api/pharma/dispatches", { customerId: pharmacy, date: iso(-5), lines: [{ productId: insulin, quantity: 10, unitPrice: "34.50" }] });

  const po2 = await api("POST", "/api/purchase-orders", { supplierId: generics, date: iso(-3), lines: [{ productId: amox, quantity: 100, unitPrice: "0.95" }] });
  await api("POST", `/api/purchase-orders/${po2.id}/approve`);
  const l2 = (await api("GET", `/api/purchase-orders/${po2.id}`)).lines as { id: string }[];
  const grn2 = await api("POST", "/api/pharma/receipts", { poId: po2.id, date: iso(-1), lines: [{ poLineId: l2[0]!.id, quantity: 100, batchNumber: "AMX2530", expiry: iso(900) }] });
  void grn2;

  const po3 = await api("POST", "/api/purchase-orders", { supplierId: devices, date: iso(-12), lines: [{ productId: gloves, quantity: 200, unitPrice: "2.20" }] });
  await api("POST", `/api/purchase-orders/${po3.id}/approve`);
  const l3 = (await api("GET", `/api/purchase-orders/${po3.id}`)).lines as { id: string }[];
  await api("POST", "/api/pharma/receipts", { poId: po3.id, date: iso(-11), lines: [{ poLineId: l3[0]!.id, quantity: 200 }] });
  await api("POST", "/api/sales-invoices", { customerId: clinic, date: iso(-4), lines: [{ productId: gloves, quantity: 20, unitPrice: "4.50" }] });

  console.log(`Seeded Mersey Pharma Distribution Ltd. Sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}
await app.close();
await db.close();
