import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { buildServer } from "@softilo/api/server";
import { createDatabase } from "@softilo/db";
import { migrateEcommerce, registerEcommerce } from "./module.js";

/** The e-commerce edition's API: the core server plus the e-commerce module. Same settings as apps/api. */
const url = process.env.DATABASE_URL || undefined;
const dataDir = url ? undefined : resolve(process.env.PGLITE_DIR ?? "../../../.data/pglite-ecommerce");
if (dataDir) mkdirSync(dataDir, { recursive: true });

const db = await createDatabase({ url, dataDir });
const ran = await migrateEcommerce(db);
if (ran.length) console.log(`Applied migrations: ${ran.join(", ")}`);

const app = await buildServer(db, { logger: { level: process.env.LOG_LEVEL ?? "info" } }, [registerEcommerce]);
const port = Number(process.env.API_PORT ?? 4000);
await app.listen({ port, host: process.env.API_HOST ?? "127.0.0.1" });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
}
