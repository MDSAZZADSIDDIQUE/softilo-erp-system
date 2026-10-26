import type { Database, Sql } from "@softilo/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError, forbidden } from "./errors.js";

export type Role = "owner" | "admin" | "finance" | "operations" | "accountant" | "viewer";

export interface Ctx {
  userId: string;
  tenantId: string;
  role: Role;
  ip?: string;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
  }
  interface FastifyRequest {
    ctx?: Ctx;
  }
}

/** Which roles may write in each area. Everyone signed in may read. */
const WRITE: Record<string, Role[]> = {
  finance: ["owner", "admin", "finance", "accountant"],
  operations: ["owner", "admin", "finance", "operations"],
  settings: ["owner", "admin"],
};

export function requireCtx(req: FastifyRequest): Ctx {
  if (!req.ctx) throw new AppError(401, "Please sign in", "unauthenticated");
  return req.ctx;
}

export function requireWrite(ctx: Ctx, area: keyof typeof WRITE) {
  if (!WRITE[area]!.includes(ctx.role)) throw forbidden();
}

/** Run a handler body in a tenant-scoped transaction. */
export function inTenant<T>(req: FastifyRequest, fn: (tx: Sql, ctx: Ctx) => Promise<T>): Promise<T> {
  const ctx = requireCtx(req);
  return req.server.db.tenant(ctx.tenantId, (tx) => fn(tx, ctx));
}

export type Reply = FastifyReply;
