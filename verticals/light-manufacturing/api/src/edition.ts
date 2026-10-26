import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "@softilo/api/server";
import { migrate, type Database } from "@softilo/db";
import type { FastifyServerOptions } from "fastify";
import { registerManufacturing } from "./modules/manufacturing.js";

/** The edition's own migrations (mfg_*.sql), applied after the core ones. */
export const MFG_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function migrateEdition(db: Database): Promise<string[]> {
  return [...await migrate(db), ...await migrate(db, MFG_MIGRATIONS_DIR)];
}

/** Softilo core plus the light manufacturing modules. */
export function buildEdition(db: Database, opts: FastifyServerOptions = {}) {
  return buildServer(db, opts, [registerManufacturing]);
}
