import type { Database } from "@softilo/db";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { registerErrorHandler } from "./lib/errors.js";
import { registerAuth } from "./modules/auth.js";
import { registerBanking } from "./modules/banking.js";
import { registerLedger } from "./modules/ledger.js";
import { registerMasterData } from "./modules/master-data.js";
import { registerPurchasing } from "./modules/purchasing.js";
import { registerSales } from "./modules/sales.js";
import { registerVat } from "./modules/vat.js";

/** A sector edition's routes, registered after the core modules (see verticals/*). */
export type ModuleRegistrar = (app: FastifyInstance) => Promise<void> | void;

export async function buildServer(db: Database, opts: FastifyServerOptions = {}, modules: ModuleRegistrar[] = []) {
  const app = Fastify({ bodyLimit: 6 * 1024 * 1024, trustProxy: true, ...opts });
  app.decorate("db", db);
  registerErrorHandler(app);
  app.get("/api/health", async () => ({ ok: true }));
  await registerAuth(app);
  await registerMasterData(app);
  await registerPurchasing(app);
  await registerSales(app);
  await registerBanking(app);
  await registerVat(app);
  await registerLedger(app);
  for (const register of modules) await register(app);
  return app;
}
