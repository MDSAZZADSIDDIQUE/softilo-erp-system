import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createDatabase, migrate } from "@softilo/db";
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

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
}
