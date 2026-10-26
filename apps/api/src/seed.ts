/**
 * Demo data for local development: a UK importer with a few months of trading.
 * Runs through the real API so every posting goes through the same rules as production.
 *
 *   pnpm seed            (uses DATABASE_URL, or the embedded dev database in .data/)
 *
 * Demo sign-in (development only):
 *   email:    demo@softilo.test
 *   password: softilo-demo-2026
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createDatabase, migrate } from "@softilo/db";
import type { InjectOptions } from "fastify";
import { buildServer } from "./server.js";

export const DEMO_EMAIL = "demo@softilo.test";
export const DEMO_PASSWORD = "softilo-demo-2026";

const url = process.env.DATABASE_URL || undefined;
const dataDir = url ? undefined : resolve(process.env.PGLITE_DIR ?? "../../.data/pglite");
if (dataDir) mkdirSync(dataDir, { recursive: true });
const db = await createDatabase({ url, dataDir });
await migrate(db);
const app = await buildServer(db);

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
  console.log("Demo company already exists; nothing to do.");
} else {
  await api("POST", "/api/auth/signup", {
    companyName: "Thames Valley Imports Ltd", companyNumber: "14523987", vatNumber: "GB284716593",
    name: "Demo User", email: DEMO_EMAIL, password: DEMO_PASSWORD,
  });
  await api("PATCH", "/api/settings", { address: { line1: "Unit 4, Kennet Trade Park", city: "Reading", postcode: "RG2 0QX", country: "GB" } });

  const c = async (kind: string, name: string, extra: object = {}) => (await api("POST", "/api/contacts", { kind, name, ...extra })).id as string;
  const shenzhen = await c("supplier", "Shenzhen Brightway Manufacturing", { currency: "USD", email: "orders@brightway.example" });
  const ningbo = await c("supplier", "Ningbo Homeware Export Co", { currency: "USD" });
  const freight = await c("supplier", "Felixstowe Freight Services Ltd", { vatNumber: "GB193847562", paymentTermsDays: 14 });
  const customs = await c("supplier", "Harbour Customs Brokers Ltd", { vatNumber: "GB556677889", paymentTermsDays: 14 });
  const landlord = await c("supplier", "Kennet Estates Ltd", { vatNumber: "GB302010405" });
  const customers = [
    await c("customer", "Oxford Kitchen Co Ltd", { email: "accounts@oxfordkitchen.example", paymentTermsDays: 30 }),
    await c("customer", "Bath Home Stores Ltd", { paymentTermsDays: 30 }),
    await c("customer", "Cotswold Interiors", { paymentTermsDays: 14 }),
    await c("customer", "Brighton Living plc", { paymentTermsDays: 60 }),
  ];

  const p = async (sku: string, name: string, weightKg: string, salesPrice: string, reorderLevel: string, hsCode: string) =>
    (await api("POST", "/api/products", { sku, name, weightKg, salesPrice, reorderLevel, hsCode })).id as string;
  const products = {
    kettle: await p("KET-ST-17", "Stainless steel kettle 1.7L", "1.2", "34.99", "40", "8516797000"),
    toaster: await p("TOA-2S-BK", "Two-slice toaster, black", "1.6", "29.99", "30", "8516720000"),
    pans: await p("PAN-SET-5", "Non-stick pan set (5 piece)", "4.5", "64.00", "20", "7323931090"),
    knives: await p("KNF-BLK-6", "Knife block, 6 piece", "2.1", "45.00", "25", "8211100000"),
    mugs: await p("MUG-SET-4", "Stoneware mugs (set of 4)", "1.8", "18.50", "60", "6912002310"),
  };

  async function importShipment(n: number, supplier: string, rate: string, billRate: string, orderDate: string, lines: [string, number, string][],
    freightNet: string, dutyNet: string, container: string, mrn: string) {
    const po = await api("POST", "/api/purchase-orders", {
      supplierId: supplier, date: orderDate, rate,
      lines: lines.map(([productId, quantity, unitPrice]) => ({ productId, quantity, unitPrice, vatCode: "OS" })),
    });
    await api("POST", `/api/purchase-orders/${po.id}/approve`);
    const detail = await api("GET", `/api/purchase-orders/${po.id}`);
    const arrival = addDays(orderDate, 35);
    await api("POST", `/api/purchase-orders/${po.id}/receive`, {
      date: arrival, lines: detail.lines.map((l: { id: string; quantity: string }) => ({ poLineId: l.id, quantity: l.quantity })),
    });
    const unbilled = await api<{ id: string }[]>("GET", `/api/goods-receipts/unbilled?supplierId=${supplier}`);
    await api("POST", "/api/supplier-bills", {
      supplierId: supplier, supplierRef: `PI-${2026}${String(n).padStart(3, "0")}`, date: addDays(arrival, 2), rate: billRate,
      lines: unbilled.map((u) => ({ kind: "receipt", receiptLineId: u.id })),
    });
    await api("POST", "/api/supplier-bills", {
      supplierId: freight, supplierRef: `FFS-${8800 + n}`, date: addDays(arrival, 3),
      lines: [{ kind: "account", accountCode: "2110", description: `Sea freight ${container}`, net: freightNet, vatCode: "S20" }],
    });
    await api("POST", "/api/supplier-bills", {
      supplierId: customs, supplierRef: `HCB-${5100 + n}`, date: addDays(arrival, 3),
      lines: [{ kind: "account", accountCode: "2110", description: `Import duty ${mrn}`, net: dutyNet, vatCode: "OS" }],
    });
    const fresh = await api("GET", `/api/purchase-orders/${po.id}`);
    const shp = await api("POST", "/api/shipments", {
      reference: container, mrn, date: arrival, receiptLineIds: fresh.receipts.map((r: { line_id: string }) => r.line_id),
    });
    await api("POST", `/api/shipments/${shp.id}/costs`, { description: "Sea freight", amountGbp: freightNet, method: "weight" });
    await api("POST", `/api/shipments/${shp.id}/costs`, { description: "Import duty", amountGbp: dutyNet, method: "value" });
    await api("POST", `/api/shipments/${shp.id}/post`, { date: addDays(arrival, 4) });
    return { arrival, goodsGbp: lines.reduce((s, [, q, u]) => s + q * Number(u) * Number(rate), 0) };
  }

  const s1 = await importShipment(1, shenzhen, "0.79", "0.785", "2026-05-04",
    [[products.kettle, 300, "9.40"], [products.toaster, 250, "8.10"]], "1450.00", "420.00", "MSCU4417820", "26GB7A1D45E2F01");
  const s2 = await importShipment(2, ningbo, "0.78", "0.79", "2026-06-15",
    [[products.pans, 150, "18.20"], [products.knives, 200, "11.75"], [products.mugs, 400, "3.30"]], "1980.00", "655.00", "OOLU8812094", "26GB7B3C11A9D02");
  const s3 = await importShipment(3, shenzhen, "0.76", "0.765", "2026-08-10",
    [[products.kettle, 200, "9.25"], [products.mugs, 300, "3.20"]], "1120.00", "310.00", "CMAU1029384", "26GB7C9F22B4E03");

  // Sales across the summer and autumn.
  const sales: [string, number, [keyof typeof products, number][]][] = [
    ["2026-06-12", 0, [["kettle", 60], ["toaster", 40]]],
    ["2026-06-25", 1, [["kettle", 40], ["toaster", 60]]],
    ["2026-07-08", 2, [["toaster", 30], ["kettle", 25]]],
    ["2026-07-28", 0, [["pans", 30], ["knives", 40], ["mugs", 80]]],
    ["2026-08-05", 3, [["pans", 45], ["mugs", 120], ["kettle", 50]]],
    ["2026-08-22", 1, [["knives", 60], ["toaster", 50]]],
    ["2026-09-10", 0, [["kettle", 80], ["mugs", 100], ["pans", 20]]],
    ["2026-09-24", 2, [["knives", 35], ["mugs", 90], ["toaster", 30]]],
    ["2026-10-06", 3, [["kettle", 70], ["pans", 25], ["knives", 30]]],
    ["2026-10-19", 1, [["mugs", 150], ["kettle", 40], ["toaster", 20]]],
  ];
  const prices: Record<keyof typeof products, string> = { kettle: "21.00", toaster: "18.00", pans: "39.00", knives: "27.50", mugs: "11.00" };
  const invoices: { id: string; customer: string; date: string }[] = [];
  for (const [date, ci, lines] of sales) {
    const inv = await api("POST", "/api/sales-invoices", {
      customerId: customers[ci], date,
      lines: lines.map(([k, quantity]) => ({ productId: products[k], quantity, unitPrice: prices[k] })),
    });
    invoices.push({ id: inv.id, customer: customers[ci]!, date });
  }

  // Customers pay the older invoices; the latest few stay open (one overdue).
  for (const inv of invoices.slice(0, 7)) {
    const detail = await api("GET", `/api/sales-invoices/${inv.id}`);
    await api("POST", "/api/payments", {
      direction: "receipt", contactId: inv.customer, date: addDays(inv.date, 28), bankAccountCode: "1200",
      amount: detail.total, reference: detail.number, allocations: [{ documentId: inv.id, amount: detail.total }],
    });
  }

  // Pay suppliers: the first two shipments in full, at the rate on the day.
  const bills = await api<{ id: string; supplier_id: string; total: string; date: string; currency: string; supplier_ref: string }[]>("GET", "/api/supplier-bills");
  for (const b of bills.filter((x) => x.supplier_ref.startsWith("FFS-88") || x.supplier_ref.startsWith("HCB-51") || x.supplier_ref === "PI-2026001" || x.supplier_ref === "PI-2026002")) {
    if (b.supplier_ref.endsWith("03")) continue;
    await api("POST", "/api/payments", {
      direction: "payment", contactId: b.supplier_id, date: addDays(b.date, 20), bankAccountCode: "1200",
      amount: b.total, rate: b.currency === "USD" ? "0.775" : undefined, reference: b.supplier_ref,
      allocations: [{ documentId: b.id, amount: b.total }],
    });
  }

  // Opening capital and monthly rent.
  await api("POST", "/api/journals", { date: "2026-05-01", memo: "Share capital and director loan introduced", lines: [
    { accountCode: "1200", debit: "40000.00" }, { accountCode: "3000", credit: "40000.00" }] });
  for (const month of ["05", "06", "07", "08", "09", "10"]) {
    await api("POST", "/api/supplier-bills", {
      supplierId: landlord, supplierRef: `KE-RENT-2026${month}`, date: `2026-${month}-01`,
      lines: [{ kind: "account", accountCode: "7100", description: `Warehouse rent ${month}/2026`, net: "2250.00", vatCode: "S20" }],
    });
  }

  // Postponed import VAT from the monthly CDS statements.
  for (const [statement, mrn, date, value] of [
    ["2026-06", "26GB7A1D45E2F01", s1.arrival, s1.goodsGbp + 1450 + 420],
    ["2026-07", "26GB7B3C11A9D02", s2.arrival, s2.goodsGbp + 1980 + 655],
    ["2026-09", "26GB7C9F22B4E03", s3.arrival, s3.goodsGbp + 1120 + 310],
  ] as const) {
    const valueGbp = value.toFixed(2);
    await api("POST", "/api/vat/pva", { statement, entries: [{ mrn, date, valueGbp, vatGbp: (value * 0.2).toFixed(2) }] });
  }

  // A bank statement for October with a few lines to reconcile.
  const csv = [
    "Date,Description,Reference,Paid in,Paid out",
    "02/10/2026,KENNET ESTATES LTD DD,RENT OCT,,2700.00",
    "15/10/2026,COTSWOLD INTERIORS,FPS,\"1,215.00\",",
    "21/10/2026,HSBC BUSINESS ACCOUNT FEE,,,18.00",
    "23/10/2026,OXFORD KITCHEN CO LTD,INV,\"2,520.00\",",
  ].join("\n");
  await api("POST", "/api/bank/import", { bankAccountCode: "1200", content: csv });

  console.log("Demo company created. Sign-in details are at the top of apps/api/src/seed.ts.");
}

function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

await app.close();
await db.close();
