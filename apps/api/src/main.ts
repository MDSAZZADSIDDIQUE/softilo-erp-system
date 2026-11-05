import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createDatabase, migrate } from "@softilo/db";
import { configurationProblems } from "./integrations/index.js";
import { runDueAutomations } from "./modules/automations.js";
import { buildServer } from "./server.js";

const url = process.env.DATABASE_URL || undefined;
if (!url && process.env.NODE_ENV === "production" && process.env.DEMO_MODE !== "1") {
  console.error("DATABASE_URL is required in production. The embedded database is for evaluation only (set DEMO_MODE=1 for a demo server).");
  process.exit(1);
}
// Without DATABASE_URL, use an embedded PGlite database on disk (development only).
const dataDir = url ? undefined : resolve(process.env.PGLITE_DIR ?? "../../.data/pglite");
if (dataDir) mkdirSync(dataDir, { recursive: true });

const db = await createDatabase({ url, dataDir });
const ran = await migrate(db);
if (ran.length) console.log(`Applied migrations: ${ran.join(", ")}`);

const app = await buildServer(db, { logger: { level: process.env.LOG_LEVEL ?? "info" } });
const port = Number(process.env.API_PORT ?? 4000);
await app.listen({ port, host: process.env.API_HOST ?? "127.0.0.1" });
for (const problem of configurationProblems(app.providers)) app.log.warn(problem);

// Automations run inside the API process. Every few minutes, each tenant's due automations run in turn.
// (Run several API processes? Set AUTOMATIONS=off on all but one, or move this loop to a worker.)
let running = false;
const every = Number(process.env.AUTOMATION_TICK_MINUTES ?? 5) * 60_000;
const timer = process.env.AUTOMATIONS === "off" ? undefined : setInterval(async () => {
  if (running) return;
  running = true;
  try { await runDueAutomations(app); } catch (e) { app.log.error(e, "automation tick failed"); } finally { running = false; }
}, every);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (timer) clearInterval(timer);
    await app.close();
    await db.close();
    process.exit(0);
  });
}
