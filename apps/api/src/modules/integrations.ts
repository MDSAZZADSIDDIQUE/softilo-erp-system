import { randomBytes } from "node:crypto";
import { newId } from "@softilo/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { describeProviders } from "../integrations/index.js";
import { inTenant, requireWrite } from "../lib/context.js";
import { fxRate, findConnection, saveTokens, syncBankFeed, type Connection } from "../lib/connections.js";
import { AppError, notFound, unprocessable } from "../lib/errors.js";
import { assertAccount, audit } from "../lib/ledger.js";
import { accountCode, currency, IdParams, isoDate, today } from "../lib/schemas.js";

/** Where HMRC and the bank send the user back to. PUBLIC_URL in production; the request's own origin in development. */
function callbackUrl(req: FastifyRequest, path: string) {
  const base = process.env.PUBLIC_URL ?? `${req.protocol}://${req.headers["x-forwarded-host"] ?? req.headers.host}`;
  return `${base.replace(/\/$/, "")}${path}`;
}

export async function registerIntegrations(app: FastifyInstance) {
  const p = app.providers;

  app.get("/api/integrations", (req) => inTenant(req, async (tx) => ({
    providers: describeProviders(p),
    connections: await tx.query(
      `SELECT id, provider, mode, status, label, external_ref, account_code, expires_at, last_synced_at, last_error, created_at
         FROM integration_connections WHERE status <> 'revoked' ORDER BY created_at DESC`),
  })));

  app.post("/api/integrations/:id/disconnect", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "settings");
    const { id } = IdParams.parse(req.params);
    const rows = await tx.query("UPDATE integration_connections SET status = 'revoked', secrets = NULL WHERE id = $1 RETURNING provider", [id]);
    if (!rows.length) throw notFound("Connection");
    await audit(tx, ctx, "integration.disconnected", "integration_connection", id);
    return { ok: true };
  }));

  // ---------------------------------------------------------------- HMRC Making Tax Digital
  app.post("/api/integrations/hmrc/connect", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const [t] = await tx.query<{ vat_number: string | null }>("SELECT vat_number FROM tenants");
    if (!t?.vat_number) throw unprocessable("Add the company's VAT number in Settings first");
    const info = p.hmrc.info();
    if (info.mode === "live" && !info.ready) throw new AppError(503, `HMRC is not configured: set ${info.missing?.join(", ")}`, "not_configured");
    await tx.query("UPDATE integration_connections SET status = 'revoked', secrets = NULL WHERE provider = 'hmrc_vat' AND status <> 'revoked'");
    const id = newId();
    const state = randomBytes(16).toString("hex");
    await tx.query(
      `INSERT INTO integration_connections (id, tenant_id, provider, mode, status, label, external_ref, state)
       VALUES ($1,$2,'hmrc_vat',$3,$4,$5,$6,$7)`,
      [id, ctx.tenantId, info.mode, info.mode === "demo" ? "connected" : "pending", info.name, t.vat_number, state]);
    await audit(tx, ctx, "integration.connect_started", "integration_connection", id, { provider: "hmrc_vat", mode: info.mode });
    const url = p.hmrc.authoriseUrl(state, callbackUrl(req, "/api/integrations/hmrc/callback"));
    return url ? { redirect: url } : { connected: true };
  }));

  app.get("/api/integrations/hmrc/callback", (req, reply) => inTenant(req, async (tx, ctx) => {
    const q = z.object({ code: z.string().optional(), state: z.string(), error: z.string().optional() }).parse(req.query);
    const [c] = await tx.query<{ id: string }>("SELECT id FROM integration_connections WHERE provider = 'hmrc_vat' AND state = $1 AND status = 'pending'", [q.state]);
    if (!c) throw unprocessable("This HMRC sign-in has expired. Start again from the VAT page.");
    if (q.error || !q.code) {
      await tx.query("UPDATE integration_connections SET status = 'error', last_error = $2 WHERE id = $1", [c.id, q.error ?? "No code returned"]);
      return reply.redirect("/vat?hmrc=declined");
    }
    await saveTokens(tx, c.id, await p.hmrc.exchangeCode(q.code, callbackUrl(req, "/api/integrations/hmrc/callback")));
    await audit(tx, ctx, "integration.connected", "integration_connection", c.id, { provider: "hmrc_vat" });
    return reply.redirect("/vat?hmrc=connected");
  }));

  // ---------------------------------------------------------------- bank feeds (Open Banking)
  app.post("/api/integrations/bank/connect", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const { bankAccountCode } = z.object({ bankAccountCode: accountCode }).parse(req.body);
    await assertAccount(tx, bankAccountCode, { bank: true });
    const info = p.bankFeed.info();
    if (info.mode === "live" && !info.ready) throw new AppError(503, `Bank feeds are not configured: set ${info.missing?.join(", ")}`, "not_configured");
    await tx.query("UPDATE integration_connections SET status = 'revoked', secrets = NULL WHERE provider = 'bank_feed' AND account_code = $1 AND status <> 'revoked'", [bankAccountCode]);
    const id = newId();
    const state = randomBytes(16).toString("hex");
    let externalRef: string | null = null;
    let label = info.name;
    if (info.mode === "demo") {
      const [acc] = await p.bankFeed.accounts({ seed: { tenantId: ctx.tenantId, today: today(), payments: [], vatPayments: [], balance: "0" } });
      externalRef = acc!.id;
      label = `${acc!.name} ${acc!.sortCode} ${acc!.accountNumber}`;
    }
    await tx.query(
      `INSERT INTO integration_connections (id, tenant_id, provider, mode, status, label, external_ref, account_code, state, expires_at)
       VALUES ($1,$2,'bank_feed',$3,$4,$5,$6,$7,$8, now() + interval '90 days')`,
      [id, ctx.tenantId, info.mode, info.mode === "demo" ? "connected" : "pending", label, externalRef ?? `pending-${id}`, bankAccountCode, state]);
    await audit(tx, ctx, "integration.connect_started", "integration_connection", id, { provider: "bank_feed", mode: info.mode, bankAccountCode });
    const url = p.bankFeed.authoriseUrl(state, callbackUrl(req, "/api/integrations/bank/callback"));
    return url ? { redirect: url } : { connected: true, id };
  }));

  app.get("/api/integrations/bank/callback", (req, reply) => inTenant(req, async (tx, ctx) => {
    const q = z.object({ code: z.string().optional(), state: z.string(), error: z.string().optional() }).parse(req.query);
    const [c] = await tx.query<{ id: string }>("SELECT id FROM integration_connections WHERE provider = 'bank_feed' AND state = $1 AND status = 'pending'", [q.state]);
    if (!c) throw unprocessable("This bank sign-in has expired. Start again from the banking page.");
    if (q.error || !q.code) {
      await tx.query("UPDATE integration_connections SET status = 'error', last_error = $2 WHERE id = $1", [c.id, q.error ?? "No code returned"]);
      return reply.redirect("/banking?feed=declined");
    }
    const tokens = await p.bankFeed.exchangeCode(q.code, callbackUrl(req, "/api/integrations/bank/callback"));
    await saveTokens(tx, c.id, tokens);
    // Consent covers 90 days under the Open Banking rules; the first account the bank returns is the one linked.
    const [acc] = await p.bankFeed.accounts({ accessToken: tokens.accessToken });
    if (acc) await tx.query("UPDATE integration_connections SET external_ref = $2, label = $3, expires_at = now() + interval '90 days' WHERE id = $1",
      [c.id, acc.id, `${acc.name}${acc.sortCode ? ` ${acc.sortCode}` : ""}${acc.accountNumber ? ` ${acc.accountNumber}` : ""}`]);
    await audit(tx, ctx, "integration.connected", "integration_connection", c.id, { provider: "bank_feed" });
    return reply.redirect("/banking?feed=connected");
  }));

  app.post("/api/integrations/bank/sync", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const { bankAccountCode } = z.object({ bankAccountCode: accountCode.default("1200") }).parse(req.body ?? {});
    const conn = await findConnection(tx, "bank_feed", bankAccountCode) as Connection | undefined;
    if (!conn) throw new AppError(409, "This bank account has no feed connected", "not_connected");
    return syncBankFeed(tx, ctx, p, conn);
  }));

  // ---------------------------------------------------------------- Companies House and VAT number checks
  app.get("/api/lookup/companies", (req) => inTenant(req, async () => {
    const { q } = z.object({ q: z.string().trim().min(2).max(100) }).parse(req.query);
    return p.companiesHouse.search(q);
  }));

  app.get("/api/lookup/companies/:number", (req) => inTenant(req, async () => {
    const { number } = z.object({ number: z.string().trim().regex(/^[A-Z0-9]{8}$/i, "Companies House numbers are 8 characters") }).parse(req.params);
    const profile = await p.companiesHouse.profile(number);
    if (!profile) throw notFound("Company");
    return profile;
  }));

  app.get("/api/lookup/vat/:number", (req) => inTenant(req, async (tx) => {
    const { number } = z.object({ number: z.string().trim().regex(/^(GB)?\d{9}(\d{3})?$/i, "UK VAT numbers are 9 or 12 digits") }).parse(req.params);
    const [t] = await tx.query<{ vat_number: string | null }>("SELECT vat_number FROM tenants");
    return p.vatCheck.check(number, t?.vat_number ?? undefined);
  }));

  /** Check a contact against Companies House and HMRC, and keep the result (and HMRC's consultation number) in the audit trail. */
  app.post("/api/contacts/:id/verify", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const [c] = await tx.query<{ name: string; company_number: string | null; vat_number: string | null }>(
      "SELECT name, company_number, vat_number FROM contacts WHERE id = $1", [id]);
    if (!c) throw notFound("Contact");
    const [t] = await tx.query<{ vat_number: string | null }>("SELECT vat_number FROM tenants");
    const company = c.company_number ? await p.companiesHouse.profile(c.company_number) : null;
    const vat = c.vat_number ? await p.vatCheck.check(c.vat_number, t?.vat_number ?? undefined) : null;
    const warnings: string[] = [];
    if (c.company_number && !company) warnings.push("The company number was not found at Companies House.");
    if (company && company.status !== "active") warnings.push(`Companies House lists this company as ${company.status}.`);
    if (vat && !vat.valid) warnings.push("HMRC does not recognise this VAT number. Do not reclaim VAT on its invoices until it is fixed.");
    const norm = (s: string) => s.toUpperCase().replace(/\b(LTD|LIMITED|PLC|LLP)\b|[^A-Z0-9]/g, "");
    if (vat?.name && norm(vat.name) !== norm(c.name)) warnings.push(`HMRC has this VAT number registered to ${vat.name}.`);
    await audit(tx, ctx, "contact.verified", "contact", id, { company: company && { number: company.companyNumber, status: company.status }, vat, warnings });
    return { company, vat, warnings, ok: !warnings.length };
  }));

  // ---------------------------------------------------------------- exchange rates
  app.get("/api/fx/rate", (req) => inTenant(req, async (tx) => {
    const q = z.object({ currency, date: isoDate.optional() }).parse(req.query);
    const r = await fxRate(tx, p, q.currency, q.date ?? today());
    if (!r) throw notFound(`A rate for ${q.currency}`);
    return { currency: q.currency, ...r };
  }));

  app.get("/api/fx/history", (req) => inTenant(req, async (tx) => {
    const q = z.object({ currency, from: isoDate, to: isoDate }).parse(req.query);
    return tx.query("SELECT date::text, rate::text, source FROM fx_rates WHERE currency = $1 AND date BETWEEN $2 AND $3 ORDER BY date", [q.currency, q.from, q.to]);
  }));
}
