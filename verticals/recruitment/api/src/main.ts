import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createDatabase } from "@softilo/db";
import { buildServer } from "@softilo/api/server";
import { migrateRecruitment, registerRecruitment } from "./index.js";

// The Recruitment edition: the core API plus the recruitment module, on its own port and database.
const url = process.env.DATABASE_URL || undefined;
const dataDir = url ? undefined : resolve(process.env.PGLITE_DIR ?? "../../../.data/pglite-recruitment");
if (dataDir) mkdirSync(dataDir, { recursive: true });

const db = await createDatabase({ url, dataDir });
const ran = await migrateRecruitment(db);
if (ran.length) console.log(`Applied migrations: ${ran.join(", ")}`);

const app = await buildServer(db, { logger: { level: process.env.LOG_LEVEL ?? "info" } }, [registerRecruitment]);
const port = Number(process.env.API_PORT ?? 4070);
await app.listen({ port, host: process.env.API_HOST ?? "127.0.0.1" });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
}
