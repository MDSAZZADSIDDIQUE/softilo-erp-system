import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createDatabase } from "@softilo/db";
import { buildLawServer, migrateLaw } from "./server.js";

const url = process.env.DATABASE_URL || undefined;
// Without DATABASE_URL, use an embedded PGlite database on disk (development only).
const dataDir = url ? undefined : resolve(process.env.PGLITE_DIR ?? "../../../.data/pglite-law");
if (dataDir) mkdirSync(dataDir, { recursive: true });

const db = await createDatabase({ url, dataDir });
const ran = await migrateLaw(db);
if (ran.length) console.log(`Applied migrations: ${ran.join(", ")}`);

const app = await buildLawServer(db, { logger: { level: process.env.LOG_LEVEL ?? "info" } });
const port = Number(process.env.API_PORT ?? 4060);
await app.listen({ port, host: process.env.API_HOST ?? "127.0.0.1" });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
}
