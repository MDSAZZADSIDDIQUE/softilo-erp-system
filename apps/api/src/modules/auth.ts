import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import cookie from "@fastify/cookie";
import { newId, type Sql } from "@softilo/db";
import { UK_CHART } from "@softilo/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireCtx, type Ctx, type Role } from "../lib/context.js";
import { AppError } from "../lib/errors.js";
import { audit } from "../lib/ledger.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const COOKIE = "softilo_session";
const SESSION_DAYS = 14;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Seed a new tenant's chart of accounts and default warehouse (runs inside the tenant's RLS scope). */
export async function seedTenant(tx: Sql, tenantId: string) {
  for (const a of UK_CHART) {
    await tx.query(
      "INSERT INTO accounts (tenant_id, code, name, type, role, is_control, is_bank) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [tenantId, a.code, a.name, a.type, a.role ?? null, a.control ?? false, a.role === "bank" || a.code === "1210"],
    );
  }
  await tx.query("INSERT INTO warehouses (id, tenant_id, code, name) VALUES ($1,$2,'MAIN','Main warehouse')", [newId(), tenantId]);
}

const SignUp = z.object({
  companyName: z.string().trim().min(2).max(160),
  companyNumber: z.string().trim().regex(/^[A-Z0-9]{8}$/i, "Companies House numbers are 8 characters").optional().or(z.literal("")),
  vatNumber: z.string().trim().regex(/^(GB)?\d{9}(\d{3})?$/i, "UK VAT numbers are 9 or 12 digits").optional().or(z.literal("")),
  name: z.string().trim().min(1).max(120),
  email: z.email().transform((e) => e.toLowerCase()),
  password: z.string().min(12, "Use at least 12 characters").max(200),
});

const SignIn = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  password: z.string().min(1),
});

export async function createTenantWithOwner(app: FastifyInstance, input: z.infer<typeof SignUp>) {
  const tenantId = newId();
  const userId = newId();
  const passwordHash = await hashPassword(input.password);
  await app.db.system(async (tx) => {
    const [existing] = await tx.query("SELECT 1 FROM users WHERE email = $1", [input.email]);
    if (existing) throw new AppError(409, "An account with this email already exists", "conflict");
    await tx.query("INSERT INTO tenants (id, name, company_number, vat_number) VALUES ($1,$2,$3,$4)",
      [tenantId, input.companyName, input.companyNumber || null, input.vatNumber?.replace(/^GB/i, "") || null]);
    await tx.query("INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)",
      [userId, input.email, input.name, passwordHash]);
    await tx.query("INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1,$2,'owner')", [userId, tenantId]);
  });
  await app.db.tenant(tenantId, async (tx) => {
    await seedTenant(tx, tenantId);
    await audit(tx, { userId, tenantId, role: "owner" }, "tenant.created", "tenant", tenantId, { name: input.companyName });
  });
  return { tenantId, userId };
}

async function startSession(app: FastifyInstance, req: FastifyRequest, userId: string, tenantId: string) {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await app.db.system((tx) => tx.query(
    "INSERT INTO sessions (id, user_id, tenant_id, ip, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [sha256(token), userId, tenantId, req.ip, req.headers["user-agent"] ?? null, expires.toISOString()],
  ));
  return { token, expires };
}

export async function registerAuth(app: FastifyInstance) {
  await app.register(cookie);
  const secure = process.env.NODE_ENV === "production";
  const setCookie = (reply: import("fastify").FastifyReply, token: string, expires: Date) =>
    reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure, path: "/", expires });

  // Resolve the session on every request.
  app.addHook("onRequest", async (req) => {
    const token = req.cookies[COOKIE];
    if (!token) return;
    const [s] = await app.db.query<{ user_id: string; tenant_id: string; role: Role }>(
      `SELECT s.user_id, s.tenant_id, m.role FROM sessions s
         JOIN memberships m ON m.user_id = s.user_id AND m.tenant_id = s.tenant_id
        WHERE s.id = $1 AND s.expires_at > now()`,
      [sha256(token)],
    );
    if (s) req.ctx = { userId: s.user_id, tenantId: s.tenant_id, role: s.role, ip: req.ip } satisfies Ctx;
  });

  // Cross-site request protection: state-changing requests must be JSON (forces a CORS preflight).
  app.addHook("preHandler", async (req) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.body !== undefined) {
      const type = req.headers["content-type"] ?? "";
      if (!type.startsWith("application/json")) throw new AppError(415, "Requests must be JSON", "unsupported_media_type");
    }
  });

  app.post("/api/auth/signup", async (req, reply) => {
    const input = SignUp.parse(req.body);
    const { tenantId, userId } = await createTenantWithOwner(app, input);
    const { token, expires } = await startSession(app, req, userId, tenantId);
    setCookie(reply, token, expires);
    return reply.status(201).send({ tenantId, userId });
  });

  app.post("/api/auth/login", async (req, reply) => {
    const input = SignIn.parse(req.body);
    const [u] = await app.db.query<{ id: string; password_hash: string; tenant_id: string | null }>(
      `SELECT u.id, u.password_hash,
              (SELECT tenant_id FROM memberships m WHERE m.user_id = u.id ORDER BY created_at LIMIT 1) AS tenant_id
         FROM users u WHERE u.email = $1`,
      [input.email],
    );
    // Same response and similar timing whether or not the email exists.
    const ok = await verifyPassword(input.password, u?.password_hash ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "==");
    if (!u || !ok || !u.tenant_id) throw new AppError(401, "Email or password is incorrect", "invalid_credentials");
    const { token, expires } = await startSession(app, req, u.id, u.tenant_id);
    setCookie(reply, token, expires);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await app.db.query("DELETE FROM sessions WHERE id = $1", [sha256(token)]);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => {
    const ctx = requireCtx(req);
    const [me] = await app.db.query<Record<string, unknown>>(
      `SELECT u.id, u.email, u.name, m.role, t.id AS tenant_id, t.name AS tenant_name, t.vat_number, t.company_number
         FROM users u JOIN memberships m ON m.user_id = u.id JOIN tenants t ON t.id = m.tenant_id
        WHERE u.id = $1 AND t.id = $2`,
      [ctx.userId, ctx.tenantId],
    );
    return me;
  });
}
