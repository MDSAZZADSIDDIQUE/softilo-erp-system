import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import cookie from "@fastify/cookie";
import { newId, type Sql } from "@softilo/db";
import { UK_CHART } from "@softilo/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireCtx, type Ctx, type Role } from "../lib/context.js";
import { DEMO_COMPANY, DEMO_EMAIL, DEMO_PASSWORD, demoEnabled } from "../lib/demo.js";
import { AppError } from "../lib/errors.js";
import { audit } from "../lib/ledger.js";
import { RateLimiter } from "../lib/rate-limit.js";
import { newSecret, otpauthUrl, recoveryCodes, verifyTotp } from "../lib/totp.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const COOKIE = "softilo_session";
const SESSION_DAYS = 14;

// Failed sign-ins per email and per address, and new companies per address.
const loginFailures = new RateLimiter(10, 15 * 60_000);
const ipFailures = new RateLimiter(50, 15 * 60_000);
const signups = new RateLimiter(process.env.NODE_ENV === "test" ? Number.MAX_SAFE_INTEGER : 20, 60 * 60_000);

function refuseIfLimited(reply: import("fastify").FastifyReply, seconds: number) {
  if (!seconds) return;
  reply.header("retry-after", seconds);
  throw new AppError(429, `Too many attempts. Try again in ${Math.ceil(seconds / 60)} minutes.`, "rate_limited");
}

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

declare module "fastify" {
  interface FastifyRequest {
    /** Signed in with a password, waiting for the second factor. */
    mfaPending?: { userId: string; tenantId: string; sessionId: string };
  }
}

async function startSession(app: FastifyInstance, req: FastifyRequest, userId: string, tenantId: string, mfaPending = false) {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await app.db.system(async (tx) => {
    await tx.query("DELETE FROM sessions WHERE user_id = $1 AND expires_at <= now()", [userId]);
    await tx.query(
      "INSERT INTO sessions (id, user_id, tenant_id, ip, user_agent, expires_at, mfa_pending) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [sha256(token), userId, tenantId, req.ip, req.headers["user-agent"] ?? null,
        // A session waiting for its second factor only lives ten minutes.
        (mfaPending ? new Date(Date.now() + 10 * 60_000) : expires).toISOString(), mfaPending],
    );
  });
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
    const [s] = await app.db.query<{ id: string; user_id: string; tenant_id: string; role: Role; mfa_pending: boolean }>(
      `SELECT s.id, s.user_id, s.tenant_id, m.role, s.mfa_pending FROM sessions s
         JOIN memberships m ON m.user_id = s.user_id AND m.tenant_id = s.tenant_id
        WHERE s.id = $1 AND s.expires_at > now()`,
      [sha256(token)],
    );
    if (s?.mfa_pending) req.mfaPending = { userId: s.user_id, tenantId: s.tenant_id, sessionId: s.id };
    else if (s) req.ctx = { userId: s.user_id, tenantId: s.tenant_id, role: s.role, ip: req.ip } satisfies Ctx;
  });

  // Cross-site request protection: state-changing requests must be JSON (forces a CORS preflight).
  app.addHook("preHandler", async (req) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.body !== undefined) {
      const type = req.headers["content-type"] ?? "";
      if (!type.startsWith("application/json")) throw new AppError(415, "Requests must be JSON", "unsupported_media_type");
    }
  });

  app.post("/api/auth/signup", async (req, reply) => {
    refuseIfLimited(reply, signups.retryAfter(req.ip));
    const input = SignUp.parse(req.body);
    signups.hit(req.ip);
    const { tenantId, userId } = await createTenantWithOwner(app, input);
    const { token, expires } = await startSession(app, req, userId, tenantId);
    setCookie(reply, token, expires);
    return reply.status(201).send({ tenantId, userId });
  });

  app.post("/api/auth/login", async (req, reply) => {
    const input = SignIn.parse(req.body);
    refuseIfLimited(reply, Math.max(loginFailures.retryAfter(input.email), ipFailures.retryAfter(req.ip)));
    const [u] = await app.db.query<{ id: string; password_hash: string; tenant_id: string | null }>(
      `SELECT u.id, u.password_hash,
              (SELECT tenant_id FROM memberships m WHERE m.user_id = u.id ORDER BY created_at LIMIT 1) AS tenant_id
         FROM users u WHERE u.email = $1`,
      [input.email],
    );
    // Same response and similar timing whether or not the email exists.
    const ok = await verifyPassword(input.password, u?.password_hash ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "==");
    if (!u || !ok || !u.tenant_id) {
      loginFailures.hit(input.email);
      ipFailures.hit(req.ip);
      throw new AppError(401, "Email or password is incorrect", "invalid_credentials");
    }
    loginFailures.clear(input.email);
    const [mfa] = await app.db.query("SELECT 1 FROM user_mfa WHERE user_id = $1 AND enabled_at IS NOT NULL", [u.id]);
    const { token, expires } = await startSession(app, req, u.id, u.tenant_id, Boolean(mfa));
    setCookie(reply, token, expires);
    return mfa ? { ok: true, mfaRequired: true } : { ok: true };
  });

  app.post("/api/auth/password", async (req) => {
    const ctx = requireCtx(req);
    const input = z.object({ current: z.string().min(1), next: z.string().min(12, "Use at least 12 characters").max(200) }).parse(req.body);
    const [u] = await app.db.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [ctx.userId]);
    if (!u || !(await verifyPassword(input.current, u.password_hash))) throw new AppError(422, "Your current password is not right", "invalid_credentials");
    await app.db.query("UPDATE users SET password_hash = $2 WHERE id = $1", [ctx.userId, await hashPassword(input.next)]);
    // Sign out everywhere else.
    await app.db.query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2", [ctx.userId, sha256(req.cookies[COOKIE] ?? "")]);
    await app.db.tenant(ctx.tenantId, (tx) => audit(tx, ctx, "auth.password_changed", "user", ctx.userId));
    return { ok: true };
  });

  // ---------------------------------------------------------------- two-factor sign-in (TOTP)
  const mfaFailures = new RateLimiter(5, 15 * 60_000);

  /** Check a 6-digit code or a recovery code; consumes the code so it cannot be replayed. */
  async function checkSecondFactor(userId: string, code: string): Promise<boolean> {
    return app.db.system(async (tx) => {
      const [m] = await tx.query<{ secret: string; last_step: string | null; recovery_codes: string[] }>(
        "SELECT secret, last_step, recovery_codes FROM user_mfa WHERE user_id = $1 FOR UPDATE", [userId]);
      if (!m) return false;
      const clean = code.trim().toUpperCase();
      const stepMatched = verifyTotp(m.secret, clean, m.last_step === null ? null : Number(m.last_step));
      if (stepMatched !== null) {
        await tx.query("UPDATE user_mfa SET last_step = $2 WHERE user_id = $1", [userId, stepMatched]);
        return true;
      }
      const hashed = sha256(clean.replace(/[^A-Z0-9]/g, ""));
      if (m.recovery_codes.includes(hashed)) {
        await tx.query("UPDATE user_mfa SET recovery_codes = array_remove(recovery_codes, $2) WHERE user_id = $1", [userId, hashed]);
        return true;
      }
      return false;
    });
  }

  app.post("/api/auth/mfa/verify", async (req, reply) => {
    const pending = req.mfaPending;
    if (!pending) throw new AppError(401, "Sign in with your password first", "unauthenticated");
    refuseIfLimited(reply, mfaFailures.retryAfter(pending.userId));
    const { code } = z.object({ code: z.string().min(6).max(12) }).parse(req.body);
    if (!(await checkSecondFactor(pending.userId, code))) {
      mfaFailures.hit(pending.userId);
      throw new AppError(401, "That code is not right. Check the time on your phone and try again.", "invalid_code");
    }
    mfaFailures.clear(pending.userId);
    await app.db.query("UPDATE sessions SET mfa_pending = false, expires_at = $2 WHERE id = $1",
      [pending.sessionId, new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString()]);
    await app.db.tenant(pending.tenantId, (tx) => audit(tx, { userId: pending.userId, tenantId: pending.tenantId, role: "viewer", ip: req.ip }, "auth.mfa_verified", "user", pending.userId));
    return { ok: true };
  });

  app.get("/api/auth/mfa", async (req) => {
    const ctx = requireCtx(req);
    const [m] = await app.db.query<{ enabled_at: string | null; codes_left: number }>(
      "SELECT enabled_at, cardinality(recovery_codes) AS codes_left FROM user_mfa WHERE user_id = $1", [ctx.userId]);
    return { enabled: Boolean(m?.enabled_at), enabledAt: m?.enabled_at ?? null, recoveryCodesLeft: m?.enabled_at ? Number(m.codes_left) : 0 };
  });

  /** Start set-up: a new secret the user scans into their authenticator app. Not active until confirmed with a code. */
  app.post("/api/auth/mfa/setup", async (req) => {
    const ctx = requireCtx(req);
    const [u] = await app.db.query<{ email: string; enabled_at: string | null }>(
      "SELECT u.email, m.enabled_at FROM users u LEFT JOIN user_mfa m ON m.user_id = u.id WHERE u.id = $1", [ctx.userId]);
    if (u?.enabled_at) throw new AppError(409, "Two-factor sign-in is already on. Turn it off first to set up a new device.", "conflict");
    const secret = newSecret();
    await app.db.query(
      `INSERT INTO user_mfa (user_id, secret) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET secret = EXCLUDED.secret, last_step = NULL, recovery_codes = '{}', enabled_at = NULL`, [ctx.userId, secret]);
    return { secret, otpauthUrl: otpauthUrl(secret, u!.email) };
  });

  app.post("/api/auth/mfa/enable", async (req) => {
    const ctx = requireCtx(req);
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code from your app") }).parse(req.body);
    if (!(await checkSecondFactor(ctx.userId!, code))) throw new AppError(422, "That code is not right. Check the time on your phone and try again.", "invalid_code");
    const codes = recoveryCodes();
    await app.db.query("UPDATE user_mfa SET enabled_at = now(), recovery_codes = $2 WHERE user_id = $1",
      [ctx.userId, codes.map((c) => sha256(c.replace(/[^A-Z0-9]/g, "")))]);
    await app.db.tenant(ctx.tenantId, (tx) => audit(tx, ctx, "auth.mfa_enabled", "user", ctx.userId));
    return { ok: true, recoveryCodes: codes };
  });

  app.post("/api/auth/mfa/disable", async (req) => {
    const ctx = requireCtx(req);
    const { code } = z.object({ code: z.string().min(6).max(12) }).parse(req.body);
    if (!(await checkSecondFactor(ctx.userId!, code))) throw new AppError(422, "That code is not right", "invalid_code");
    await app.db.query("DELETE FROM user_mfa WHERE user_id = $1", [ctx.userId]);
    await app.db.tenant(ctx.tenantId, (tx) => audit(tx, ctx, "auth.mfa_disabled", "user", ctx.userId));
    return { ok: true };
  });

  // What the login page needs to offer the sample company.
  app.get("/api/auth/demo", async () => {
    if (!demoEnabled()) return { available: false };
    const [u] = await app.db.query("SELECT 1 FROM users WHERE email = $1", [DEMO_EMAIL]);
    return u ? { available: true, email: DEMO_EMAIL, password: DEMO_PASSWORD, company: DEMO_COMPANY } : { available: false };
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
      `SELECT u.id, u.email, u.name, m.role, t.id AS tenant_id, t.name AS tenant_name, t.vat_number, t.company_number,
              (SELECT enabled_at IS NOT NULL FROM user_mfa x WHERE x.user_id = u.id) IS TRUE AS mfa_enabled
         FROM users u JOIN memberships m ON m.user_id = u.id JOIN tenants t ON t.id = m.tenant_id
        WHERE u.id = $1 AND t.id = $2`,
      [ctx.userId, ctx.tenantId],
    );
    return me;
  });
}
