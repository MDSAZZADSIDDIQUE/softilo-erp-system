/**
 * Demo data: Thames Valley Imports Ltd, a Reading housewares importer with six months of trading.
 * Runs through the real API so every posting goes through the same rules as production.
 *
 *   pnpm seed           (uses DATABASE_URL, or the embedded database in .data/)
 *   pnpm seed:reset     (clears the embedded database and creates the demo again)
 *
 * Sign-in details are in lib/demo.ts. The login page offers them in development, and in production only with DEMO_MODE=1.
 */
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createDatabase, migrate } from "@softilo/db";
import type { InjectOptions } from "fastify";
import { createProviders } from "./integrations/index.js";
import { DEMO_EMAIL, DEMO_PASSWORD, DEMO_TEAM } from "./lib/demo.js";
import { storeDocument } from "./modules/documents.js";
import { DEMO_DOCUMENTS } from "./lib/demo-documents.js";
import { buildServer } from "./server.js";

const url = process.env.DATABASE_URL || undefined;
const dataDir = url ? undefined : resolve(process.env.PGLITE_DIR ?? "../../.data/pglite");
if (process.env.NODE_ENV === "production" && process.env.DEMO_MODE !== "1") {
  throw new Error("Refusing to create the demo company, whose password is public, in production. Set DEMO_MODE=1 on a demo-only server.");
}
if (process.argv.includes("--reset")) {
  if (!dataDir) throw new Error("--reset only clears the embedded database. Drop and recreate a real database yourself.");
  rmSync(dataDir, { recursive: true, force: true });
}
if (dataDir) mkdirSync(dataDir, { recursive: true });
const db = await createDatabase({ url, dataDir });
await migrate(db);
// The seed always uses the demo AI reader so it is repeatable and spends nothing; documents can be re-read live in the app.
const app = await buildServer(db, { providers: createProviders({ ...process.env, AI_MODE: "demo" }) });

/**
 * Trading volumes: a Reading importer with five staff in its first year, heading for roughly £450k of sales a year. Container loads and
 * sales quantities are multiplied by this so freight lands at a realistic 10-20% of goods value.
 */
const SCALE = 6;

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
    companyName: "Thames Valley Imports Ltd", companyNumber: "14523987", vatNumber: "GB284716531",
    name: "Rebecca Lawson", email: DEMO_EMAIL, password: DEMO_PASSWORD,
  });
  await api("PATCH", "/api/settings", { address: { line1: "Unit 4, Kennet Trade Park", city: "Reading", postcode: "RG2 0QX", country: "GB",
    email: "accounts@thamesvalleyimports.example", phone: "0118 496 0712", bankName: "NatWest", sortCode: "60-24-17", accountNumber: "41873309" } });

  const c = async (kind: string, name: string, extra: object = {}) => (await api("POST", "/api/contacts", { kind, name, ...extra })).id as string;
  const shenzhen = await c("supplier", "Shenzhen Brightway Manufacturing", { currency: "USD", email: "orders@brightway.example" });
  const ningbo = await c("supplier", "Ningbo Homeware Export Co", { currency: "USD" });
  const freight = await c("supplier", "Felixstowe Freight Services Ltd", { vatNumber: "GB193847518", companyNumber: "05529761", email: "accounts@felixstowefreight.example", paymentTermsDays: 14 });
  const customs = await c("supplier", "Harbour Customs Brokers Ltd", { vatNumber: "GB556677830", companyNumber: "06115830", paymentTermsDays: 14 });
  const landlord = await c("supplier", "Kennet Estates Ltd", { vatNumber: "GB302010449", companyNumber: "03977412" });
  const customers = [
    await c("customer", "Oxford Kitchen Co Ltd", { email: "accounts@oxfordkitchen.example", companyNumber: "09811234", vatNumber: "GB221548332", paymentTermsDays: 30, creditLimit: "60000" }),
    await c("customer", "Bath Home Stores Ltd", { email: "payables@bathhomestores.example", companyNumber: "07264418", paymentTermsDays: 30, creditLimit: "40000" }),
    // Still set up under the old company, which has since been dissolved: the supplier check flags it.
    await c("customer", "Cotswold Interiors", { email: "hello@cotswoldinteriors.example", companyNumber: "04412290", paymentTermsDays: 14 }),
    await c("customer", "Brighton Living plc", { email: "ap@brightonliving.example", companyNumber: "11893052", vatNumber: "GB317726452", paymentTermsDays: 60, creditLimit: "90000" }),
  ];

  const p = async (sku: string, name: string, weightKg: string, salesPrice: string, reorderLevel: string, hsCode: string) =>
    (await api("POST", "/api/products", { sku, name, weightKg, salesPrice, reorderLevel: String(Number(reorderLevel) * SCALE), hsCode })).id as string;
  const products = {
    kettle: await p("KET-ST-17", "Stainless steel kettle 1.7L", "1.2", "34.99", "40", "8516797000"),
    toaster: await p("TOA-2S-BK", "Two-slice toaster, black", "1.6", "29.99", "30", "8516720000"),
    pans: await p("PAN-SET-5", "Non-stick pan set (5 piece)", "4.5", "64.00", "20", "7323931090"),
    knives: await p("KNF-BLK-6", "Knife block, 6 piece", "2.1", "45.00", "25", "8211100000"),
    mugs: await p("MUG-SET-4", "Stoneware mugs (set of 4)", "1.8", "18.50", "60", "6912002310"),
  };

  async function importShipment(n: number, supplier: string, rate: string, billRate: string, orderDate: string, lines: [string, number, string][],
    freightNet: string, dutyAt1x: string, container: string, mrn: string) {
    const dutyNet = (Number(dutyAt1x) * SCALE).toFixed(2);
    const po = await api("POST", "/api/purchase-orders", {
      supplierId: supplier, date: orderDate, rate,
      lines: lines.map(([productId, quantity, unitPrice]) => ({ productId, quantity: quantity * SCALE, unitPrice, vatCode: "OS" })),
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
    return { arrival, goodsGbp: lines.reduce((s, [, q, u]) => s + q * SCALE * Number(u) * Number(rate), 0), costs: Number(freightNet) + Number(dutyNet) };
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
  // Trade prices: roughly half the recommended retail price before VAT, as UK retailers expect.
  const prices: Record<keyof typeof products, string> = { kettle: "15.50", toaster: "13.25", pans: "29.00", knives: "20.50", mugs: "8.25" };
  const invoices: { id: string; customer: string; date: string }[] = [];
  for (const [date, ci, lines] of sales) {
    const inv = await api("POST", "/api/sales-invoices", {
      customerId: customers[ci], date,
      lines: lines.map(([k, quantity]) => ({ productId: products[k], quantity: quantity * SCALE, unitPrice: prices[k] })),
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
    { accountCode: "1200", debit: "250000.00" }, { accountCode: "3000", credit: "250000.00" }] });
  for (const month of ["05", "06", "07", "08", "09", "10"]) {
    await api("POST", "/api/supplier-bills", {
      supplierId: landlord, supplierRef: `KE-RENT-2026${month}`, date: `2026-${month}-01`,
      lines: [{ kind: "account", accountCode: "7100", description: `Warehouse rent ${month}/2026`, net: "2250.00", vatCode: "S20" }],
    });
  }

  // Postponed import VAT from the monthly CDS statements.
  for (const [statement, mrn, date, value] of [
    ["2026-06", "26GB7A1D45E2F01", s1.arrival, s1.goodsGbp + s1.costs],
    ["2026-07", "26GB7B3C11A9D02", s2.arrival, s2.goodsGbp + s2.costs],
    ["2026-09", "26GB7C9F22B4E03", s3.arrival, s3.goodsGbp + s3.costs],
  ] as const) {
    const valueGbp = value.toFixed(2);
    await api("POST", "/api/vat/pva", { statement, entries: [{ mrn, date, valueGbp, vatGbp: (value * 0.2).toFixed(2) }] });
  }

  // A bank statement for October with a few lines to reconcile.
  const csv = [
    "Date,Description,Reference,Paid in,Paid out",
    "02/10/2026,KENNET ESTATES LTD DD,RENT OCT,,2700.00",
    "15/10/2026,COTSWOLD INTERIORS,FPS,\"1,215.00\",",
    "21/10/2026,BUSINESS ACCOUNT FEE,,,18.00",
    "23/10/2026,OXFORD KITCHEN CO LTD,INV,\"2,520.00\",",
  ].join("\n");
  await api("POST", "/api/bank/import", { bankAccountCode: "1200", content: csv });

  // A wider range and more trade customers, with autumn containers landed and sold.
  const northern = await c("customer", "Harrogate Cookshop Ltd", { email: "buying@harrogatecookshop.example", companyNumber: "12667301", paymentTermsDays: 30, address: { line1: "12 Station Parade", city: "Harrogate", postcode: "HG1 1UE", country: "GB" } });
  const hotel = await c("customer", "Solent Hotel Supplies Ltd", { email: "purchasing@solenthotelsupplies.example", companyNumber: "08470215", paymentTermsDays: 45, vatNumber: "GB482915716", creditLimit: "35000" });
  // A young online retailer on a tight credit limit, which it has gone over.
  const online = await c("customer", "Kitchen Corner Online Ltd", { email: "ap@kitchencorner.example", companyNumber: "13310877", paymentTermsDays: 14, creditLimit: "25000" });
  const guangzhou = await c("supplier", "Guangzhou Pearl Appliances Co", { currency: "USD", email: "sales@pearlappliances.example" });
  const accountants = await c("supplier", "Abbey Square Accountants LLP", { vatNumber: "GB374620102", companyNumber: "OC398812", paymentTermsDays: 30 });
  const utility = await c("supplier", "Southern Business Energy Ltd", { vatNumber: "GB560193846", companyNumber: "10204466", paymentTermsDays: 14 });
  const fryer = await p("AFR-4L-BK", "Air fryer 4L, black", "5.2", "89.00", "30", "8516600000");
  const blender = await p("BLD-600-SS", "Jug blender 600W, stainless", "3.1", "54.00", "25", "8509400000");
  const scales = await p("SCL-DIG-5", "Digital kitchen scales 5kg", "0.6", "19.50", "40", "8423100000");

  const s4 = await importShipment(4, guangzhou, "0.75", "0.752", "2026-08-24",
    [[fryer, 220, "19.50"], [blender, 180, "14.20"], [scales, 300, "4.60"]], "2260.00", "780.00", "MAEU7302215", "26GB7D2E88C1F04");
  const s5 = await importShipment(5, shenzhen, "0.755", "0.75", "2026-09-07",
    [[products.kettle, 250, "9.30"], [products.mugs, 200, "3.25"]], "1310.00", "365.00", "TGHU5518806", "26GB7E5A07D3B05");
  await api("POST", "/api/vat/pva", { statement: "2026-09", entries: [{ mrn: "26GB7D2E88C1F04", date: s4.arrival, valueGbp: (s4.goodsGbp + s4.costs).toFixed(2), vatGbp: ((s4.goodsGbp + s4.costs) * 0.2).toFixed(2) }] });
  await api("POST", "/api/vat/pva", { statement: "2026-10", entries: [{ mrn: "26GB7E5A07D3B05", date: s5.arrival, valueGbp: (s5.goodsGbp + s5.costs).toFixed(2), vatGbp: ((s5.goodsGbp + s5.costs) * 0.2).toFixed(2) }] });

  const autumn: [string, string, string, [string, number, string][]][] = [
    ["2026-09-30", northern, "HC-20418", [[fryer, 30, "39.50"], [scales, 40, "8.40"]]],
    ["2026-10-02", hotel, "SHS-7731", [[products.kettle, 60, "15.25"], [blender, 20, "23.50"]]],
    ["2026-10-05", online, "KCO-1192", [[fryer, 45, "38.00"], [blender, 30, "23.00"], [scales, 60, "8.25"]]],
    ["2026-10-09", customers[0]!, "OK-5520", [[fryer, 25, "39.50"], [scales, 30, "8.40"]]],
    ["2026-10-14", northern, "HC-20466", [[blender, 25, "23.75"], [products.mugs, 60, "8.25"]]],
    ["2026-10-21", hotel, "SHS-7802", [[fryer, 20, "38.75"], [products.kettle, 40, "15.25"]]],
    ["2026-10-26", online, "KCO-1240", [[fryer, 40, "38.00"], [scales, 50, "8.25"], [blender, 15, "23.00"]]],
    ["2026-10-29", customers[3]!, "BL-99017", [[fryer, 35, "38.75"], [blender, 40, "23.00"], [products.kettle, 30, "15.50"]]],
  ];
  const autumnDocs: { id: string; customer: string; total: string; number: string }[] = [];
  for (const [date, customerId, customerRef, lines] of autumn) {
    const inv = await api("POST", "/api/sales-invoices", { customerId, date, customerRef, lines: lines.map(([productId, quantity, unitPrice]) => ({ productId, quantity: quantity * SCALE, unitPrice })) });
    const detail = await api("GET", `/api/sales-invoices/${inv.id}`);
    autumnDocs.push({ id: inv.id, customer: customerId, total: detail.total, number: detail.number });
  }

  // Returns: two faulty air fryers credited back to Harrogate, and the credit set against the invoice it relates to.
  const credit = await api("POST", "/api/credit-notes", { customerId: northern, date: "2026-10-12", creditsId: autumnDocs[0]!.id, customerRef: "Faulty on arrival",
    lines: [{ productId: fryer, quantity: 2, unitPrice: "39.50" }] });
  const creditTotal = (await api("GET", `/api/sales-invoices/${credit.id}`)).total as string;
  await api("POST", `/api/credit-notes/${credit.id}/apply`, { invoiceId: autumnDocs[0]!.id, amount: creditTotal });
  // Receipts on the autumn invoices: one in full, one part paid.
  await api("POST", "/api/payments", { direction: "receipt", contactId: northern, date: "2026-10-28", bankAccountCode: "1200",
    amount: (Number(autumnDocs[0]!.total) - Number(creditTotal)).toFixed(2), reference: autumnDocs[0]!.number,
    allocations: [{ documentId: autumnDocs[0]!.id, amount: (Number(autumnDocs[0]!.total) - Number(creditTotal)).toFixed(2) }] });
  await api("POST", "/api/payments", { direction: "receipt", contactId: online, date: "2026-10-22", bankAccountCode: "1200",
    amount: "15000.00", reference: `On account ${autumnDocs[2]!.number}`, allocations: [{ documentId: autumnDocs[2]!.id, amount: "15000.00" }] });

  // Purchasing still in progress: a draft, an order on the water, and a delivery that arrived short and is waiting to be costed.
  await api("POST", "/api/purchase-orders", { supplierId: ningbo, date: "2026-10-28", rate: "0.76",
    lines: [{ productId: products.pans, quantity: 120 * SCALE, unitPrice: "18.40", vatCode: "OS" }, { productId: products.knives, quantity: 100 * SCALE, unitPrice: "11.90", vatCode: "OS" }] });
  const onWater = await api("POST", "/api/purchase-orders", { supplierId: shenzhen, date: "2026-10-12", rate: "0.755",
    lines: [{ productId: products.toaster, quantity: 300 * SCALE, unitPrice: "8.25", vatCode: "OS" }] });
  await api("POST", `/api/purchase-orders/${onWater.id}/approve`);
  const shortDelivery = await api("POST", "/api/purchase-orders", { supplierId: guangzhou, date: "2026-09-21", rate: "0.75",
    lines: [{ productId: scales, quantity: 400 * SCALE, unitPrice: "4.55", vatCode: "OS" }, { productId: blender, quantity: 150 * SCALE, unitPrice: "14.10", vatCode: "OS" }] });
  await api("POST", `/api/purchase-orders/${shortDelivery.id}/approve`);
  const shortLines = (await api("GET", `/api/purchase-orders/${shortDelivery.id}`)).lines as { id: string; product_id: string }[];
  await api("POST", `/api/purchase-orders/${shortDelivery.id}/receive`, { date: "2026-10-27",
    lines: [{ poLineId: shortLines.find((l) => l.product_id === scales)!.id, quantity: 400 * SCALE }, { poLineId: shortLines.find((l) => l.product_id === blender)!.id, quantity: 90 * SCALE }] });
  const shortReceipts = await api("GET", `/api/purchase-orders/${shortDelivery.id}`);
  await api("POST", "/api/shipments", { reference: "CAIU3390471", mrn: "26GB7F1B36E2A06", date: "2026-10-27",
    receiptLineIds: shortReceipts.receipts.map((r: { line_id: string }) => r.line_id) });

  // Stock housekeeping and a credit from the haulier.
  const overflow = (await api("POST", "/api/warehouses", { code: "OVF", name: "Overflow store, Theale" })).id as string;
  await api("POST", "/api/stock/adjustments", { date: "2026-10-16", productId: products.mugs, quantity: -6, reason: "Breakages found at stock count" });
  await api("POST", "/api/stock/adjustments", { date: "2026-10-16", productId: scales, warehouseId: overflow, quantity: 12, unitCostGbp: "4.10", reason: "Pallet found at overflow store during stock count" });
  await api("POST", "/api/supplier-bills", { kind: "credit", supplierId: freight, supplierRef: "FFS-CN-214", date: "2026-10-08",
    lines: [{ kind: "account", accountCode: "5200", description: "Demurrage overcharge refunded", net: "185.00", vatCode: "S20" }] });

  // Running costs, so the P&L looks like a real business: payroll, power and the accountant.
  for (const month of ["05", "06", "07", "08", "09", "10"]) {
    await api("POST", "/api/journals", { date: `2026-${month}-28`, memo: `Payroll ${month}/2026, five staff`, lines: [
      { accountCode: "7000", debit: "15520.00" }, { accountCode: "1200", credit: "11660.00" }, { accountCode: "2210", credit: "3860.00" }] });
    // PAYE and National Insurance go to HMRC by the 22nd of the following month.
    if (month !== "10") {
      await api("POST", "/api/journals", { date: `2026-${String(Number(month) + 1).padStart(2, "0")}-22`, memo: `PAYE and NI paid to HMRC ${month}/2026`, lines: [
        { accountCode: "2210", debit: "3860.00" }, { accountCode: "1200", credit: "3860.00" }] });
    }
    await api("POST", "/api/supplier-bills", { supplierId: utility, supplierRef: `SBE-2026${month}`, date: `2026-${month}-08`,
      lines: [{ kind: "account", accountCode: "7200", description: `Warehouse electricity ${month}/2026`, net: "386.40", vatCode: "S20" }] });
  }
  await api("POST", "/api/supplier-bills", { supplierId: accountants, supplierRef: "ASA-2291", date: "2026-07-20",
    lines: [{ kind: "account", accountCode: "7600", description: "Annual accounts and corporation tax return", net: "2400.00", vatCode: "S20" }] });

  // Rent and power paid to date; October's are still open.
  for (const b of await api<{ id: string; supplier_id: string; total: string; date: string; supplier_ref: string }[]>("GET", "/api/supplier-bills")) {
    if (/^(KE-RENT|SBE)-2026(05|06|07|08|09)$/.test(b.supplier_ref) || b.supplier_ref === "ASA-2291") {
      await api("POST", "/api/payments", { direction: "payment", contactId: b.supplier_id, date: addDays(b.date, 3), bankAccountCode: "1200",
        amount: b.total, reference: b.supplier_ref, allocations: [{ documentId: b.id, amount: b.total }] });
    }
  }

  // Part of October's statement already reconciled: matched payments, plus the bank fee coded straight to the ledger.
  type Pay = { id: string; date: string; amount: string; rate: string; direction: string; reference: string | null };
  const october = (await api<Pay[]>("GET", "/api/payments")).filter((x) => x.date >= "2026-10-01" && x.date <= "2026-10-31" && Number(x.rate ?? 1) === 1).slice(0, 4);
  const ukDate = (iso: string) => iso.split("-").reverse().join("/");
  await api("POST", "/api/bank/import", { bankAccountCode: "1200", content: [
    "Date,Description,Reference,Paid in,Paid out",
    ...october.map((x) => `${ukDate(x.date)},${x.direction === "receipt" ? "FASTER PAYMENT IN" : "BACS OUT"},${x.reference ?? ""},${x.direction === "receipt" ? x.amount : ""},${x.direction === "receipt" ? "" : x.amount}`),
    "21/09/2026,MONTHLY ACCOUNT FEE,,,18.00",
  ].join("\n") });
  type Line = { id: string; amount: string; description: string };
  const lines = await api<Line[]>("GET", "/api/bank/transactions?status=unreconciled");
  for (const x of october) {
    const signed = x.direction === "receipt" ? Number(x.amount) : -Number(x.amount);
    const line = lines.find((l) => Number(l.amount) === signed && /FASTER PAYMENT IN|BACS OUT/.test(l.description));
    if (line) {
      lines.splice(lines.indexOf(line), 1);
      await api("POST", `/api/bank/transactions/${line.id}/match`, { paymentId: x.id });
    }
  }
  const fee = lines.find((l) => l.description === "MONTHLY ACCOUNT FEE");
  if (fee) await api("POST", `/api/bank/transactions/${fee.id}/post`, { accountCode: "7900", vatCode: "OS", description: "Monthly account fee" });

  // Last quarter's VAT return is finalised (which locks the period) and filed with HMRC through the MTD simulator;
  // the current quarter stays open. Nothing dated before 1 August can be posted after this.
  const vat26A1 = await api("POST", "/api/vat/returns", { periodKey: "26A1", from: "2026-05-01", to: "2026-07-31" });
  await api("POST", "/api/integrations/hmrc/connect");
  await api("POST", `/api/vat/returns/${vat26A1.id}/submit`, { declaration: true, fraud: { timezone: "UTC+01:00", screens: "width=1920&height=1080&scaling-factor=1&colour-depth=24", windowSize: "width=1512&height=860", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Safari/605.1.15" } });
  // It was filed on 2 September: date the record as it would have been on the day.
  await db.query(`UPDATE vat_returns SET submitted_at = '2026-09-02 10:14:00+01', hmrc_receipt = jsonb_set(hmrc_receipt, '{processingDate}', '"2026-09-02T09:14:07.000Z"') WHERE id = $1`, [vat26A1.id]);
  // If HMRC is owed money, it was paid by bank transfer a few days before the 7 September deadline.
  if (Number(vat26A1.boxes.box3) > Number(vat26A1.boxes.box4)) {
    await api("POST", "/api/journals", { date: "2026-09-03", memo: "VAT 26A1 paid to HMRC", lines: [
      { accountCode: "2202", debit: vat26A1.boxes.box5 }, { accountCode: "1200", credit: vat26A1.boxes.box5 }] });
  }

  // ---------------------------------------------------------------- platform services
  // Accounts for the costs that only ever arrive through the bank, and rules that code them automatically.
  await api("POST", "/api/accounts", { code: "7300", name: "Motor and fuel", type: "expense" });
  await api("POST", "/api/accounts", { code: "7400", name: "Insurance", type: "expense" });
  await api("POST", "/api/accounts", { code: "7510", name: "Postage and carriage out", type: "expense" });
  await api("POST", "/api/accounts", { code: "7520", name: "Telephone and internet", type: "expense" });
  await api("POST", "/api/accounts", { code: "4910", name: "Bank interest received", type: "income" });
  for (const [name, matchText, direction, accountCode, vatCode] of [
    ["Bank charges", "MONTHLY ACCOUNT FEE", "out", "7900", "EX"],
    ["Van fuel", "SHELL", "out", "7300", "S20"],
    ["Postage", "ROYAL MAIL", "out", "7510", "EX"],
    ["Broadband and phones", "BT BUSINESS", "out", "7520", "S20"],
    ["Business insurance", "HISCOX", "out", "7400", "EX"],
    ["Office supplies", "AMAZON MKTPLACE", "out", "7500", "S20"],
    ["Interest", "CREDIT INTEREST", "in", "4910", "EX"],
  ] as const) await api("POST", "/api/bank/rules", { name, matchText, direction, accountCode, vatCode });

  // The current account is linked by Open Banking; the feed carries on from the last statement imported.
  await api("POST", "/api/integrations/bank/connect", { bankAccountCode: "1200" });

  // The finance team and the company's accountant.
  for (const m of DEMO_TEAM) await api("POST", "/api/team", { name: m.name, email: m.email, role: m.role, temporaryPassword: DEMO_PASSWORD });

  // Six months of daily reference rates, for the FX chart and as defaults on new foreign orders.
  for (let day = addDays(todayUtc(), -183); day <= todayUtc(); day = addDays(day, 1)) {
    if ([0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay())) continue;
    await api("GET", `/api/fx/rate?currency=USD&date=${day}`);
    await api("GET", `/api/fx/rate?currency=EUR&date=${day}`);
  }

  // Paperwork that arrived this week and is waiting in the inbox.
  const me = await api<{ id: string; tenant_id: string }>("GET", "/api/auth/me");
  await db.tenant(me.tenant_id, async (tx) => {
    for (const doc of DEMO_DOCUMENTS) {
      await storeDocument(tx, { userId: me.id, tenantId: me.tenant_id, role: "owner" }, { ...doc, mediaType: "text/plain", source: "email" });
    }
  });

  // Let the automations do a first pass, as they would overnight.
  for (const kind of ["document_reading", "bank_feed_sync", "bank_matching", "overdue_reminders", "reorder", "fx_rates"]) {
    const run = await api<{ summary: string }>("POST", `/api/automations/${kind}/run`);
    console.log(`  ${kind}: ${run.summary}`);
  }

  console.log(`Created the demo company. Open the login page and choose "Open the demo", or sign in as ${DEMO_EMAIL}.`);
}

function todayUtc() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
}

function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

await app.close();
await db.close();
