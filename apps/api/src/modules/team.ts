import { newId } from "@softilo/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inTenant, requireCtx, requireWrite, type Role } from "../lib/context.js";
import { sendEmail } from "../lib/email.js";
import { AppError, notFound, unprocessable } from "../lib/errors.js";
import { audit } from "../lib/ledger.js";
import { uuid } from "../lib/schemas.js";
import { hashPassword } from "./auth.js";

const ROLES = ["owner", "admin", "finance", "operations", "accountant", "viewer"] as const;

/** What each role can do, shown on the team page so owners choose roles knowingly. */
export const ROLE_HELP: Record<Role, string> = {
  owner: "Everything, including re-opening locked periods and managing the team.",
  admin: "Everything except re-opening locked periods.",
  finance: "Bills, payments, banking, VAT and journals, plus operations.",
  operations: "Purchase orders, goods in, shipments, products and sales invoices.",
  accountant: "The company's external accountant: finance work and journals, read access to everything else.",
  viewer: "Read-only access to everything.",
};

export async function registerTeam(app: FastifyInstance) {
  app.get("/api/team", (req) => inTenant(req, async (tx) => ({
    members: await tx.query(
      `SELECT u.id, u.name, u.email, m.role, m.created_at, (x.enabled_at IS NOT NULL) AS mfa_enabled
         FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN user_mfa x ON x.user_id = u.id ORDER BY m.created_at`),
    roles: ROLES.map((r) => ({ id: r, help: ROLE_HELP[r] })),
  })));

  /**
   * Add a colleague. Someone new gets an account with a temporary password (sent to them by email) that they
   * change after signing in; someone who already uses Softilo elsewhere (an accountant with several clients)
   * is simply given access to this company.
   */
  app.post("/api/team", async (req, reply) => {
    const ctx = requireCtx(req);
    const input = z.object({
      name: z.string().trim().min(1).max(120), email: z.email().transform((e) => e.toLowerCase()), role: z.enum(ROLES),
      temporaryPassword: z.string().min(12, "Use at least 12 characters").max(200),
    }).parse(req.body);
    await inTenant(req, async (_tx, c) => requireWrite(c, "settings"));
    if (input.role === "owner" && ctx.role !== "owner") throw new AppError(403, "Only an owner can add another owner", "forbidden");
    const passwordHash = await hashPassword(input.temporaryPassword);
    const userId = await app.db.system(async (tx) => {
      const [u] = await tx.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [input.email]);
      const id = u?.id ?? newId();
      if (!u) await tx.query("INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)", [id, input.email, input.name, passwordHash]);
      const [m] = await tx.query("SELECT 1 FROM memberships WHERE user_id = $1 AND tenant_id = $2", [id, ctx.tenantId]);
      if (m) throw new AppError(409, `${input.email} is already in the team`, "conflict");
      await tx.query("INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1,$2,$3)", [id, ctx.tenantId, input.role]);
      return { id, existing: Boolean(u) };
    });
    await inTenant(req, async (tx, c) => {
      const [t] = await tx.query<{ name: string }>("SELECT name FROM tenants");
      await audit(tx, c, "team.member_added", "user", userId.id, { email: input.email, role: input.role });
      await sendEmail(tx, c, app.providers, {
        template: "invitation", to: input.email, toName: input.name,
        subject: `You have been added to ${t!.name} on Softilo`,
        body: `Hello ${input.name},\n\nYou now have ${input.role} access to ${t!.name} on Softilo ERP.\n\n`
          + (userId.existing ? "Sign in with your usual Softilo password and choose the company from the menu." : "Your colleague will give you a temporary password. Please change it after you first sign in, and turn on two-factor sign-in in Settings.")
          + "\n\nSoftilo ERP",
      });
    });
    return reply.status(201).send({ id: userId.id, existing: userId.existing });
  });

  app.patch("/api/team/:userId", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "settings");
    const { userId } = z.object({ userId: uuid }).parse(req.params);
    const { role } = z.object({ role: z.enum(ROLES) }).parse(req.body);
    if ((role === "owner" || userId === ctx.userId) && ctx.role !== "owner") throw new AppError(403, "Only an owner can do that", "forbidden");
    const [owners] = await tx.query<{ n: string }>("SELECT count(*) AS n FROM memberships WHERE role = 'owner' AND user_id <> $1", [userId]);
    if (role !== "owner" && Number(owners!.n) === 0) throw unprocessable("The company needs at least one owner");
    const rows = await tx.query("UPDATE memberships SET role = $2 WHERE user_id = $1 RETURNING user_id", [userId, role]);
    if (!rows.length) throw notFound("Team member");
    await audit(tx, ctx, "team.role_changed", "user", userId, { role });
    return { ok: true };
  }));

  app.delete("/api/team/:userId", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "settings");
    const { userId } = z.object({ userId: uuid }).parse(req.params);
    if (userId === ctx.userId) throw unprocessable("You cannot remove yourself");
    const [m] = await tx.query<{ role: string }>("SELECT role FROM memberships WHERE user_id = $1", [userId]);
    if (!m) throw notFound("Team member");
    if (m.role === "owner" && ctx.role !== "owner") throw new AppError(403, "Only an owner can remove an owner", "forbidden");
    await tx.query("DELETE FROM memberships WHERE user_id = $1", [userId]);
    await audit(tx, ctx, "team.member_removed", "user", userId);
    return { ok: true };
  }));
}
