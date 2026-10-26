/**
 * Demo data for local development: a small high-street firm with three matters.
 * Runs through the real API so every posting goes through the same rules as production.
 *
 *   pnpm --filter @softilo-law/api seed   (uses DATABASE_URL, or the embedded dev database in .data/pglite-law)
 *
 * Demo sign-in (development only):
 *   email:    demo-law@softilo.test
 *   password: softilo-demo-2026
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createDatabase } from "@softilo/db";
import type { InjectOptions } from "fastify";
import { buildLawServer, migrateLaw } from "./server.js";

export const DEMO_EMAIL = "demo-law@softilo.test";
export const DEMO_PASSWORD = "softilo-demo-2026";

const url = process.env.DATABASE_URL || undefined;
const dataDir = url ? undefined : resolve(process.env.PGLITE_DIR ?? "../../../.data/pglite-law");
if (dataDir) mkdirSync(dataDir, { recursive: true });
const db = await createDatabase({ url, dataDir });
await migrateLaw(db);
const app = await buildLawServer(db);

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
  console.log("Demo firm already exists; nothing to do.");
} else {
  await api("POST", "/api/auth/signup", {
    companyName: "Hartley & Webb LLP", companyNumber: "OC412345", vatNumber: "GB123456789",
    name: "Amara Hartley", email: DEMO_EMAIL, password: DEMO_PASSWORD,
  });
  await api("POST", "/api/law/setup", {});
  const ah = (await api("POST", "/api/law/fee-earners", { name: "Amara Hartley", initials: "AH", hourlyRate: "275" })).id;
  const jw = (await api("POST", "/api/law/fee-earners", { name: "James Webb", initials: "JW", hourlyRate: "195" })).id;
  const okafor = (await api("POST", "/api/law/clients", { name: "Daniel Okafor", clientType: "individual", email: "daniel@example.com", cddComplete: true })).id;
  const pennine = (await api("POST", "/api/law/clients", { name: "Pennine Estates Ltd", clientType: "organisation", cddComplete: true })).id;
  const evans = (await api("POST", "/api/law/clients", { name: "Executors of M. Evans", clientType: "individual" })).id;

  const purchase = (await api("POST", "/api/law/matters", { clientId: okafor, description: "Purchase of 14 Mill Lane, Leeds", feeEarnerId: ah, openedOn: "2026-09-01" })).id;
  const lease = (await api("POST", "/api/law/matters", { clientId: pennine, description: "Lease renewal, Unit 4 Kirkgate", feeEarnerId: jw, openedOn: "2026-09-08" })).id;
  const estate = (await api("POST", "/api/law/matters", { clientId: evans, description: "Estate of Margaret Evans", feeEarnerId: ah, openedOn: "2026-09-15" })).id;

  await api("POST", `/api/law/matters/${purchase}/receipts`, { date: "2026-09-03", amount: "1500", counterparty: "Daniel Okafor", reference: "Money on account" });
  await api("POST", `/api/law/matters/${purchase}/receipts`, { date: "2026-10-01", amount: "32500", counterparty: "Daniel Okafor", reference: "Deposit and SDLT" });
  await api("POST", `/api/law/matters/${purchase}/payments`, { date: "2026-10-02", amount: "198", counterparty: "Search provider", reference: "Local authority search" });
  for (const [day, minutes, narrative] of [["08", 72, "Review contract pack and title"], ["12", 30, "Raise enquiries"], ["20", 18, "Report to client on title"]] as const) {
    await api("POST", `/api/law/matters/${purchase}/time`, { date: `2026-09-${day}`, minutes, narrative });
  }
  const fn = await api("POST", `/api/law/matters/${purchase}/fee-notes`, { date: "2026-10-05" });
  await api("POST", `/api/law/fee-notes/${fn.id}/transfer`, { date: "2026-10-06", amount: fn.total });

  await api("POST", `/api/law/matters/${lease}/receipts`, { date: "2026-09-10", amount: "2000", counterparty: "Pennine Estates Ltd", reference: "Money on account" });
  await api("POST", `/api/law/matters/${lease}/time`, { date: "2026-09-18", minutes: 95, narrative: "Review draft lease and heads of terms", feeEarnerId: jw });

  await api("POST", `/api/law/matters/${estate}/receipts`, { date: "2026-10-12", amount: "48210.55", counterparty: "Yorkshire Building Society", reference: "Account closure" });
  await api("POST", `/api/law/matters/${estate}/payments`, { date: "2026-10-14", amount: "273", counterparty: "HM Courts & Tribunals Service", reference: "Probate application fee" });
  await api("POST", `/api/law/matters/${estate}/time`, { date: "2026-10-14", minutes: 45, narrative: "Prepare probate application" });

  console.log(`Demo firm created. Sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}
await app.close();
await db.close();
