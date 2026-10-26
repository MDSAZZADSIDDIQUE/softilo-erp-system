import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, type Database } from "@softilo/db";
import { buildServer } from "@softilo/api/dist/server.js";
import type { FastifyServerOptions } from "fastify";
import { registerConstruction, type ConstructionOptions } from "./module.js";

export const CONSTRUCTION_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Core migrations first, then the construction edition's own (prefixed cons_). */
export async function migrateConstruction(db: Database): Promise<string[]> {
  return [...await migrate(db), ...await migrate(db, CONSTRUCTION_MIGRATIONS)];
}

/** The core Softilo API plus the construction routes. */
export async function buildConstructionServer(db: Database, opts: FastifyServerOptions = {}, construction: ConstructionOptions = {}) {
  const app = await buildServer(db, opts);
  await registerConstruction(app, construction);
  return app;
}
