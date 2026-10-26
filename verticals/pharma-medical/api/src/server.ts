import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, type Database } from "@softilo/db";
import type { FastifyServerOptions } from "fastify";
import { buildServer } from "./core.js";
import { registerPharma } from "./modules/pharma.js";

export const PHARMA_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Core migrations first, then this edition's pharma_* migrations. */
export async function migratePharma(db: Database): Promise<string[]> {
  return [...await migrate(db), ...await migrate(db, PHARMA_MIGRATIONS)];
}

/** The core API plus the pharmaceutical & medical wholesale module. */
export function buildPharmaServer(db: Database, opts: FastifyServerOptions = {}) {
  return buildServer(db, opts, [registerPharma]);
}
