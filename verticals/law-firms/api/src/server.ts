import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, type Database } from "@softilo/db";
import { buildServer } from "@softilo/api/server";
import type { FastifyServerOptions } from "fastify";
import { registerLaw } from "./module.js";

export const LAW_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Core migrations first, then the law-firm tables (law_*.sql). */
export async function migrateLaw(db: Database): Promise<string[]> {
  return [...await migrate(db), ...await migrate(db, LAW_MIGRATIONS_DIR)];
}

/** The core Softilo API plus the law-firm module under /api/law. */
export async function buildLawServer(db: Database, opts: FastifyServerOptions = {}) {
  const app = await buildServer(db, opts);
  await registerLaw(app);
  return app;
}
