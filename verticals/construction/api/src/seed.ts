/**
 * Demo data for the construction edition: a main contractor with two projects, three
 * subcontractors (one at each CIS rate), job bills, payments and applications for payment.
 *
 * Sign in with:  demo@brickbeam.example  /  demo construction 2026
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createDatabase } from "@softilo/db";
import { buildConstructionServer, migrateConstruction } from "./server.js";

const url = process.env.DATABASE_URL || undefined;
const dataDir = url ? undefined : resolve(process.env.PGLITE_DIR ?? "../../../.data/pglite-construction");
if (dataDir) mkdirSync(dataDir, { recursive: true });
const db = await createDatabase({ url, dataDir });
await migrateConstruction(db);
const app = await buildConstructionServer(db);

let cookie = "";
async function call(method: "GET" | "POST" | "PUT", path: string, body?: unknown) {
  const res = await app.inject({ method, url: path, payload: body as never, headers: cookie ? { cookie } : {} });
  const set = res.headers["set-cookie"];
  if (set) cookie = (Array.isArray(set) ? set[0]! : set).split(";")[0]!;
  if (res.statusCode >= 400) throw new Error(`${method} ${path} → ${res.statusCode}: ${res.body}`);
  return res.body ? res.json() : undefined;
}

const exists = await db.query("SELECT 1 FROM users WHERE email = 'demo@brickbeam.example'");
if (exists.length) {
  console.log("Demo data already present.");
} else {
  await call("POST", "/api/auth/signup", {
    companyName: "Brick & Beam Contractors Ltd", companyNumber: "11223344", vatNumber: "GB223344556",
    name: "Dev Patel", email: "demo@brickbeam.example", password: "demo construction 2026",
  });
  await call("PUT", "/api/construction/settings", { contractorUtr: "1234567890", employerRef: "123/AB45678", accountsOfficeRef: "123PA00012345" });
  const developer = (await call("POST", "/api/contacts", { kind: "customer", name: "Northgate Developments Ltd", vatNumber: "GB998877665" })).id;
  const school = (await call("POST", "/api/contacts", { kind: "customer", name: "St Anne's Academy Trust", vatNumber: "GB556677889" })).id;
  const flats = (await call("POST", "/api/construction/projects", {
    code: "NG01", name: "Northgate flats, block A", customerId: developer, siteAddress: "Northgate Road, Leicester LE1 4AA",
    contractSum: "250000", retentionRate: "0.05", startDate: "2026-08-03",
    budget: [
      { category: "labour", description: "Groundworks and brickwork", amount: "95000" },
      { category: "materials", description: "Concrete, bricks and blocks", amount: "70000" },
      { category: "plant", description: "Excavator, scaffold and welfare", amount: "18000" },
      { category: "other", description: "Skips and testing", amount: "6000" },
    ],
  })).id;
  const hall = (await call("POST", "/api/construction/projects", {
    code: "SA01", name: "Academy sports hall refurbishment", customerId: school, contractSum: "48000", retentionRate: "0.03", endUserNotice: true,
    budget: [{ category: "labour", description: "Strip out and refit", amount: "22000" }, { category: "materials", description: "Flooring and lighting", amount: "14000" }],
  })).id;
  const ace = (await call("POST", "/api/construction/subcontractors", { name: "Ace Brickwork Ltd", vatNumber: "GB111222333", businessType: "company", utr: "2222222222", companyNumber: "09876543" })).id;
  const smith = (await call("POST", "/api/construction/subcontractors", { name: "J Smith Groundworks", businessType: "sole_trader", utr: "3333333338", nino: "AB123456C" })).id;
  const roof = (await call("POST", "/api/construction/subcontractors", { name: "Peak Roofing Ltd", vatNumber: "GB777888999", businessType: "company", utr: "4444444440" })).id;
  await call("POST", "/api/construction/subcontractors", { name: "Kowalski Plastering", businessType: "sole_trader", utr: "5555555555" });
  for (const id of [ace, smith, roof]) await call("POST", `/api/construction/subcontractors/${id}/verify`);
  const merchant = (await call("POST", "/api/contacts", { kind: "supplier", name: "Midland Builders Merchants", vatNumber: "GB444555666" })).id;

  const bill = async (supplierId: string, projectId: string, supplierRef: string, date: string, lines: unknown[]) =>
    call("POST", "/api/construction/bills", { supplierId, projectId, supplierRef, date, lines });
  const b1 = await bill(ace, flats, "ACE-0412", "2026-09-12", [
    { category: "labour", description: "Brickwork, ground floor", net: "18500" }, { category: "materials", description: "Wall ties and mortar", net: "2300" }]);
  const b2 = await bill(smith, flats, "JS-007", "2026-09-15", [{ category: "labour", description: "Foundations and drainage", net: "9200" }]);
  await bill(merchant, flats, "MBM-50112", "2026-09-18", [{ category: "materials", description: "Ready-mix concrete", net: "11800" }]);
  const b3 = await bill(roof, hall, "PR-221", "2026-10-02", [
    { category: "labour", description: "Roof light replacement", net: "6400" }, { category: "materials", description: "Roof lights", net: "3900" }, { category: "plant", description: "Cherry picker hire", net: "650" }]);
  const b4 = await bill(ace, flats, "ACE-0431", "2026-10-14", [
    { category: "labour", description: "Brickwork, first floor", net: "16200" }, { category: "materials", description: "Lintels", net: "1450" }]);
  const pay = (contactId: string, date: string, bill: { id: string; payable: string }, amount = bill.payable) =>
    call("POST", "/api/payments", { direction: "payment", contactId, date, bankAccountCode: "1200", amount, allocations: [{ documentId: bill.id, amount }] });
  await pay(ace, "2026-09-26", b1);
  await pay(smith, "2026-09-26", b2, "3000.00");
  await pay(smith, "2026-10-17", b2, "3440.00");
  await pay(roof, "2026-10-20", b3);
  await pay(ace, "2026-10-28", b4);
  await call("POST", "/api/construction/cis/returns", { monthEnding: "2026-10-05", declarations: { employmentStatus: true, verification: true } });

  await call("POST", `/api/construction/projects/${flats}/applications`, { date: "2026-09-30", periodEnd: "2026-09-30", grossToDate: "62000" });
  await call("POST", `/api/construction/projects/${flats}/applications`, { date: "2026-10-31", periodEnd: "2026-10-31", grossToDate: "118500" });
  await call("POST", `/api/construction/projects/${hall}/applications`, { date: "2026-10-31", periodEnd: "2026-10-31", grossToDate: "21000" });
  const v = await call("POST", `/api/construction/projects/${flats}/variations`, { description: "Additional surface water drainage run", amount: "7800", date: "2026-10-09" });
  await call("POST", `/api/construction/variations/${v.id}/approve`);
  await call("POST", `/api/construction/projects/${flats}/variations`, { description: "Upgrade to engineering bricks below DPC", amount: "2350", date: "2026-10-21" });
  console.log("Seeded Brick & Beam Contractors Ltd. Sign in with demo@brickbeam.example / demo construction 2026");
}
await app.close();
await db.close();
