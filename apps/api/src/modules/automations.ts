import { newId, type Sql } from "@softilo/db";
import { d, postBankEntry, type VatCode } from "@softilo/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { automationCtx, inTenant, requireWrite, type Ctx } from "../lib/context.js";
import { fxRate, syncBankFeed, type Connection } from "../lib/connections.js";
import { invoiceText, reminderText, sendEmail } from "../lib/email.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { audit, loadRoles, nextNumber, postJournal } from "../lib/ledger.js";
import { accountCode, IdParams, today, uuid, vatCode } from "../lib/schemas.js";
import { readDocument } from "./documents.js";
import { createPayment, PaymentInput } from "./sales.js";

type Providers = FastifyInstance["providers"];
interface Action { type: string; entity: string; id?: string; label: string }
interface Result { status: "ok" | "partial" | "skipped"; summary: string; actions: Action[] }

interface Definition {
  title: string;
  description: string;
  /** How often the scheduler runs it, in minutes. */
  every: number;
  defaults: Record<string, unknown>;
  run(tx: Sql, ctx: Ctx, providers: Providers, settings: Record<string, unknown>): Promise<Result>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- bank

async function bankFeedSync(tx: Sql, ctx: Ctx, providers: Providers): Promise<Result> {
  const conns = await tx.query<Connection>("SELECT * FROM integration_connections WHERE provider = 'bank_feed' AND status = 'connected'");
  if (!conns.length) return { status: "skipped", summary: "No bank feed is connected.", actions: [] };
  const actions: Action[] = [];
  let added = 0;
  for (const c of conns) {
    const r = await syncBankFeed(tx, ctx, providers, c);
    added += r.added;
    actions.push({ type: "synced", entity: "bank_account", id: c.id, label: `${c.account_code}: ${plural(r.added, "new line")} (${r.from} to ${r.to})` });
  }
  return { status: "ok", summary: `Fetched ${plural(added, "new bank line")} from ${plural(conns.length, "feed")}.`, actions };
}

type Line = { id: string; date: string; description: string; reference: string | null; amount: string; bank_account_code: string };

/**
 * Reconcile what can be reconciled without a person: lines that match exactly one recorded payment,
 * lines that pay exactly one open invoice or bill from a contact named on the line, and lines a bank rule codes.
 * Anything ambiguous is left for someone to decide.
 */
async function bankMatching(tx: Sql, ctx: Ctx, _p: Providers, s: Record<string, unknown>): Promise<Result> {
  const lines = await tx.query<Line>(
    "SELECT id, date::text, description, reference, amount::text, bank_account_code FROM bank_transactions WHERE status = 'unreconciled' ORDER BY date");
  const rules = await tx.query<{ id: string; name: string; match_text: string; direction: string; account_code: string; vat_code: string }>(
    "SELECT * FROM bank_rules WHERE active ORDER BY length(match_text) DESC");
  const contacts = await tx.query<{ id: string; name: string }>("SELECT id, name FROM contacts WHERE NOT archived");
  const roles = await loadRoles(tx);
  const actions: Action[] = [];
  const key = (x: string) => x.toUpperCase().replace(/\b(LTD|LIMITED|PLC|LLP|CO)\b|[^A-Z0-9]/g, "");
  for (const l of lines) {
    const moneyIn = Number(l.amount) > 0;
    // 1. A payment already recorded in Softilo for the same amount, a few days either side.
    const pays = await tx.query<{ id: string; number: string }>(
      `SELECT p.id, p.number FROM payments p
        WHERE p.bank_account_code = $1 AND p.direction = $2 AND round(p.amount * p.rate, 2) = abs($3::numeric)
          AND p.date BETWEEN $4::date - 5 AND $4::date + 2
          AND NOT EXISTS (SELECT 1 FROM bank_transactions x WHERE x.payment_id = p.id)`,
      [l.bank_account_code, moneyIn ? "receipt" : "payment", l.amount, l.date]);
    if (pays.length === 1) {
      await tx.query("UPDATE bank_transactions SET status = 'reconciled', payment_id = $2, matched_by = 'automation' WHERE id = $1", [l.id, pays[0]!.id]);
      await audit(tx, ctx, "bank.matched", "bank_transaction", l.id, { paymentId: pays[0]!.id, by: "automation" });
      actions.push({ type: "matched", entity: "bank_transaction", id: l.id, label: `${l.date} ${l.description} → ${pays[0]!.number}` });
      continue;
    }
    // 2. Exactly one open GBP document for this amount, from a contact whose name is on the line.
    if (s.createPayments !== false) {
      const named = contacts.filter((c) => key(c.name).length >= 5 && key(`${l.description} ${l.reference ?? ""}`).includes(key(c.name).slice(0, 12)));
      if (named.length === 1) {
        const table = moneyIn ? "sales_invoices" : "supplier_bills";
        const party = moneyIn ? "customer_id" : "supplier_id";
        const docs = await tx.query<{ id: string; number: string }>(
          `SELECT id, number FROM ${table} WHERE ${party} = $1 AND kind = $2 AND currency = 'GBP' AND total - amount_paid = abs($3::numeric)`,
          [named[0]!.id, moneyIn ? "invoice" : "bill", l.amount]);
        if (docs.length === 1) {
          const pay = await createPayment(tx, ctx, PaymentInput.parse({
            direction: moneyIn ? "receipt" : "payment", contactId: named[0]!.id, date: l.date, bankAccountCode: l.bank_account_code,
            currency: "GBP", amount: l.amount.replace("-", ""), reference: l.reference ?? l.description,
            allocations: [{ documentId: docs[0]!.id, amount: l.amount.replace("-", "") }],
          }));
          await tx.query("UPDATE bank_transactions SET status = 'reconciled', payment_id = $2, matched_by = 'automation' WHERE id = $1", [l.id, pay.id]);
          actions.push({ type: "paid", entity: "bank_transaction", id: l.id, label: `${l.date} ${l.description} → ${pay.number} against ${docs[0]!.number}` });
          continue;
        }
      }
    }
    // 3. A bank rule (fees, card spend, direct debits).
    const hay = `${l.description} ${l.reference ?? ""}`.toUpperCase();
    const rule = rules.find((r) => hay.includes(r.match_text.toUpperCase()) && (r.direction === "any" || (r.direction === "in") === moneyIn));
    if (rule) {
      const posting = postBankEntry(roles, {
        date: l.date, reference: l.reference ?? l.description, bankAccount: l.bank_account_code, gross: l.amount,
        account: rule.account_code, vatCode: rule.vat_code as VatCode, description: `${rule.name}: ${l.description}`,
      });
      const entry = await postJournal(tx, ctx, posting, { type: "bank_transaction", id: l.id });
      await tx.query("UPDATE bank_transactions SET status = 'reconciled', entry_id = $2, matched_by = 'rule' WHERE id = $1", [l.id, entry.id]);
      await audit(tx, ctx, "bank.posted", "bank_transaction", l.id, { rule: rule.name, accountCode: rule.account_code, by: "automation" });
      actions.push({ type: "coded", entity: "bank_transaction", id: l.id, label: `${l.date} ${l.description} → ${rule.account_code} (${rule.name})` });
    }
  }
  const left = lines.length - actions.length;
  return {
    status: actions.length ? "ok" : "skipped",
    summary: lines.length ? `Reconciled ${plural(actions.length, "bank line")}; ${plural(left, "line")} left for review.` : "Nothing to reconcile.",
    actions,
  };
}

// ---------------------------------------------------------------- credit control

async function overdueReminders(tx: Sql, ctx: Ctx, providers: Providers, s: Record<string, unknown>): Promise<Result> {
  const stages = (Array.isArray(s.stages) ? s.stages : [3, 14, 30]).map(Number).sort((a, b) => a - b);
  const invoices = await tx.query<{ id: string; number: string; date: string; due_date: string; total: string; outstanding: string; currency: string;
    customer_name: string; email: string | null; reminders: boolean; customer_ref: string | null; days_overdue: number; company_name: string }>(
    `SELECT i.id, i.number, i.date::text, i.due_date::text, i.total::text, (i.total - i.amount_paid)::text AS outstanding, i.currency,
            c.name AS customer_name, c.email, c.reminders, i.customer_ref, (current_date - i.due_date) AS days_overdue, t.name AS company_name
       FROM sales_invoices i JOIN contacts c ON c.id = i.customer_id CROSS JOIN tenants t
      WHERE i.kind = 'invoice' AND i.amount_paid < i.total AND i.due_date < current_date ORDER BY i.due_date`);
  const [bank] = await tx.query<{ name: string | null; sort_code: string | null; account: string | null }>(
    "SELECT address->>'bankName' AS name, address->>'sortCode' AS sort_code, address->>'accountNumber' AS account FROM tenants");
  const actions: Action[] = [];
  let skipped = 0;
  for (const inv of invoices) {
    const stage = stages.filter((n) => inv.days_overdue >= n).length as 0 | 1 | 2 | 3;
    if (!stage) continue;
    const level = Math.min(stage, 3) as 1 | 2 | 3;
    const [sent] = await tx.query("SELECT 1 FROM outbox_messages WHERE related_id = $1 AND template = $2 AND status = 'sent'", [inv.id, `reminder_${level}`]);
    if (sent) continue;
    if (!inv.email || !inv.reminders) { skipped++; continue; }
    const text = reminderText(level, inv, { name: bank?.name ?? "", sortCode: bank?.sort_code ?? undefined, account: bank?.account ?? undefined });
    const r = await sendEmail(tx, ctx, providers, { template: `reminder_${level}`, to: inv.email, toName: inv.customer_name, ...text, relatedType: "sales_invoice", relatedId: inv.id, by: "automation" });
    actions.push({ type: r.status === "sent" ? "emailed" : "failed", entity: "sales_invoice", id: inv.id,
      label: `${["", "Reminder", "Second reminder", "Final notice"][level]} for ${inv.number} to ${inv.customer_name} (${inv.days_overdue} days overdue)` });
  }
  const summary = actions.length || skipped
    ? `Sent ${plural(actions.length, "reminder")}${skipped ? `; ${plural(skipped, "invoice")} skipped (no email address or reminders off)` : ""}.`
    : "No reminders due today.";
  return { status: actions.length ? "ok" : "skipped", summary, actions };
}

// ---------------------------------------------------------------- purchasing

/**
 * For each stock item at or below its reorder level, with nothing already on order to cover it, draft a
 * purchase order to the supplier it was last bought from, at the last price, for enough to cover twice the
 * reorder level. Drafts still need someone to approve them.
 */
async function reorder(tx: Sql, ctx: Ctx, providers: Providers, s: Record<string, unknown>): Promise<Result> {
  const cover = Number(s.coverMultiple ?? 2);
  const items = await tx.query<{ id: string; sku: string; name: string; on_hand: string; on_order: string; reorder_level: string;
    supplier_id: string | null; currency: string | null; unit_price: string | null; draft_open: boolean }>(
    `SELECT p.id, p.sku, p.name, p.reorder_level::text,
            coalesce((SELECT sum(quantity) FROM stock_balances b WHERE b.product_id = p.id), 0)::text AS on_hand,
            coalesce((SELECT sum(l.quantity - l.received_qty) FROM purchase_order_lines l JOIN purchase_orders o ON o.id = l.po_id
                       WHERE l.product_id = p.id AND o.status IN ('draft','approved','part_received')), 0)::text AS on_order,
            last.supplier_id, last.currency, last.unit_price::text,
            EXISTS (SELECT 1 FROM purchase_order_lines l JOIN purchase_orders o ON o.id = l.po_id
                     WHERE l.product_id = p.id AND o.status = 'draft') AS draft_open
       FROM products p
       LEFT JOIN LATERAL (SELECT o.supplier_id, o.currency, l.unit_price FROM purchase_order_lines l JOIN purchase_orders o ON o.id = l.po_id
                           WHERE l.product_id = p.id AND o.status <> 'cancelled' ORDER BY o.date DESC LIMIT 1) last ON true
      WHERE p.track_stock AND NOT p.archived AND p.reorder_level IS NOT NULL`);
  const need = items.filter((i) => !i.draft_open && d(i.on_hand).plus(i.on_order).lessThanOrEqualTo(i.reorder_level) && i.supplier_id);
  const bySupplier = new Map<string, typeof need>();
  for (const i of need) bySupplier.set(i.supplier_id!, [...(bySupplier.get(i.supplier_id!) ?? []), i]);
  const actions: Action[] = [];
  for (const [supplierId, lines] of bySupplier) {
    const cur = lines[0]!.currency ?? "GBP";
    const r = await fxRate(tx, providers, cur, today());
    const id = newId();
    const number = await nextNumber(tx, ctx, "purchase_order");
    const [w] = await tx.query<{ id: string }>("SELECT id FROM warehouses ORDER BY code = 'MAIN' DESC, code LIMIT 1");
    await tx.query(
      `INSERT INTO purchase_orders (id, tenant_id, number, supplier_id, warehouse_id, date, currency, rate, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9)`,
      [id, ctx.tenantId, number, supplierId, w!.id, today(), cur, r?.rate ?? "1",
        `Drafted by the reorder automation: ${lines.map((l) => l.sku).join(", ")} at or below reorder level. Check quantities and prices before approving.`]);
    let n = 1;
    for (const l of lines) {
      const short = d(l.reorder_level).times(cover).minus(l.on_hand).minus(l.on_order);
      const qty = Math.max(10, Math.ceil(short.toNumber() / 10) * 10);
      await tx.query(
        `INSERT INTO purchase_order_lines (id, tenant_id, po_id, line_no, product_id, description, quantity, unit_price, vat_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OS')`, [newId(), ctx.tenantId, id, n++, l.id, l.name, qty, l.unit_price ?? "0"]);
    }
    await audit(tx, ctx, "purchase_order.created", "purchase_order", id, { number, by: "reorder automation" });
    actions.push({ type: "drafted", entity: "purchase_order", id, label: `${number}: ${lines.map((l) => l.sku).join(", ")}` });
  }
  return { status: actions.length ? "ok" : "skipped", summary: actions.length ? `Drafted ${plural(actions.length, "purchase order")} for ${plural(need.length, "product")} below reorder level.` : "Nothing needs reordering.", actions };
}

// ---------------------------------------------------------------- reference data and documents

async function fxRates(tx: Sql, _ctx: Ctx, providers: Providers): Promise<Result> {
  const curs = await tx.query<{ currency: string }>(
    `SELECT DISTINCT currency FROM (SELECT currency FROM contacts UNION SELECT currency FROM purchase_orders) c WHERE currency <> 'GBP' ORDER BY 1`);
  const actions: Action[] = [];
  for (const { currency } of curs) {
    const r = await fxRate(tx, providers, currency, today());
    if (r) actions.push({ type: "rate", entity: "fx_rate", label: `${currency} ${r.date}: £${Number(r.rate).toFixed(4)} (${r.source})` });
  }
  return { status: actions.length ? "ok" : "skipped", summary: actions.length ? `Updated ${plural(actions.length, "exchange rate")}.` : "No foreign currencies in use.", actions };
}

async function documentReading(tx: Sql, ctx: Ctx, providers: Providers): Promise<Result> {
  const docs = await tx.query<{ id: string; filename: string }>("SELECT id, filename FROM documents WHERE status = 'received' ORDER BY created_at LIMIT 20");
  const actions: Action[] = [];
  let failed = 0;
  for (const doc of docs) {
    const r = await readDocument(tx, ctx, providers, doc.id);
    if (r.status === "failed") failed++;
    actions.push({ type: r.status, entity: "document", id: doc.id, label: `${doc.filename}: ${r.status === "failed" ? r.error : `${r.doc_type?.replace("_", " ")}, ${Math.round(Number(r.confidence ?? 0) * 100)}% confident`}` });
  }
  return {
    status: failed ? "partial" : actions.length ? "ok" : "skipped",
    summary: docs.length ? `Read ${plural(docs.length - failed, "document")}${failed ? `; ${failed} could not be read` : ""}. Drafts wait for review in the inbox.` : "No new documents.",
    actions,
  };
}

export const AUTOMATIONS: Record<string, Definition> = {
  bank_feed_sync: { title: "Fetch bank transactions", description: "Pulls new lines from each connected bank feed into reconciliation.", every: 60, defaults: {}, run: bankFeedSync },
  bank_matching: { title: "Reconcile the bank", description: "Matches lines to recorded payments, records payments that clearly settle one open invoice or bill, and codes lines your bank rules recognise. Anything ambiguous is left for you.", every: 60, defaults: { createPayments: true }, run: bankMatching },
  overdue_reminders: { title: "Chase overdue invoices", description: "Emails customers a reminder, a second reminder and a final notice as invoices pass each stage overdue.", every: 1440, defaults: { stages: [3, 14, 30] }, run: overdueReminders },
  reorder: { title: "Draft reorders", description: "Drafts purchase orders for stock at or below its reorder level, to the last supplier at the last price. Drafts need approval.", every: 1440, defaults: { coverMultiple: 2 }, run: reorder },
  fx_rates: { title: "Update exchange rates", description: "Fetches the day's reference rates for the currencies you trade in, used as defaults on foreign orders and bills.", every: 1440, defaults: {}, run: fxRates },
  document_reading: { title: "Read incoming documents", description: "Reads new supplier invoices, freight and customs paperwork in the inbox and prepares drafts for review. Nothing is posted until someone approves it.", every: 15, defaults: {}, run: documentReading },
};

async function ensureRules(tx: Sql, tenantId: string) {
  for (const [kind, def] of Object.entries(AUTOMATIONS)) {
    await tx.query("INSERT INTO automation_rules (tenant_id, kind, settings) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [tenantId, kind, JSON.stringify(def.defaults)]);
  }
}

/** Run one automation for one tenant in its own transaction, and log the run (also when it fails). */
export async function runAutomation(app: FastifyInstance, tenantId: string, kind: string, trigger: "schedule" | "manual" | "event", userId: string | null = null) {
  const def = AUTOMATIONS[kind];
  if (!def) throw notFound("Automation");
  const started = new Date().toISOString();
  const ctx: Ctx = userId ? { userId, tenantId, role: "owner", ip: "automation" } : automationCtx(tenantId);
  try {
    return await app.db.tenant(tenantId, async (tx) => {
      await ensureRules(tx, tenantId);
      const [rule] = await tx.query<{ enabled: boolean; settings: Record<string, unknown> }>("SELECT enabled, settings FROM automation_rules WHERE kind = $1", [kind]);
      const result: Result = trigger === "schedule" && !rule!.enabled
        ? { status: "skipped", summary: "Turned off.", actions: [] }
        : await def.run(tx, ctx, app.providers, { ...def.defaults, ...rule!.settings });
      const id = newId();
      await tx.query(
        "INSERT INTO automation_runs (id, tenant_id, kind, trigger, status, summary, actions, started_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [id, tenantId, kind, trigger, result.status, result.summary, JSON.stringify(result.actions), started]);
      await tx.query("UPDATE automation_rules SET last_run_at = now() WHERE kind = $1", [kind]);
      return { id, kind, ...result };
    });
  } catch (e) {
    const message = (e as Error).message;
    await app.db.tenant(tenantId, (tx) => tx.query(
      "INSERT INTO automation_runs (id, tenant_id, kind, trigger, status, summary, started_at) VALUES ($1,$2,$3,$4,'failed',$5,$6)",
      [newId(), tenantId, kind, trigger, `Failed: ${message}`, started]));
    return { id: null, kind, status: "failed" as const, summary: `Failed: ${message}`, actions: [] };
  }
}

/** Called by the scheduler in main.ts: run whatever is due for every tenant. */
export async function runDueAutomations(app: FastifyInstance) {
  const tenants = await app.db.query<{ id: string }>("SELECT id FROM tenants");
  for (const t of tenants) {
    const rules = await app.db.tenant(t.id, async (tx) => {
      await ensureRules(tx, t.id);
      return tx.query<{ kind: string; enabled: boolean; last_run_at: string | null }>("SELECT kind, enabled, last_run_at FROM automation_rules");
    });
    for (const r of rules) {
      const def = AUTOMATIONS[r.kind];
      if (!def || !r.enabled) continue;
      if (r.last_run_at && Date.now() - new Date(r.last_run_at).getTime() < def.every * 60_000) continue;
      await runAutomation(app, t.id, r.kind, "schedule");
    }
  }
}

export async function registerAutomations(app: FastifyInstance) {
  app.get("/api/automations", (req) => inTenant(req, async (tx, ctx) => {
    await ensureRules(tx, ctx.tenantId);
    const rules = await tx.query<{ kind: string; enabled: boolean; settings: unknown; last_run_at: string | null }>("SELECT * FROM automation_rules ORDER BY kind");
    const last = await tx.query<{ kind: string; status: string; summary: string; finished_at: string }>(
      "SELECT DISTINCT ON (kind) kind, status, summary, finished_at FROM automation_runs ORDER BY kind, started_at DESC");
    return Object.entries(AUTOMATIONS).map(([kind, def]) => {
      const r = rules.find((x) => x.kind === kind);
      return { kind, title: def.title, description: def.description, everyMinutes: def.every, enabled: r?.enabled ?? true,
        settings: r?.settings ?? def.defaults, lastRunAt: r?.last_run_at ?? null, lastRun: last.find((x) => x.kind === kind) ?? null };
    });
  }));

  app.patch("/api/automations/:kind", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "settings");
    const { kind } = z.object({ kind: z.string() }).parse(req.params);
    if (!AUTOMATIONS[kind]) throw notFound("Automation");
    const body = z.object({ enabled: z.boolean().optional(), settings: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
    await ensureRules(tx, ctx.tenantId);
    await tx.query("UPDATE automation_rules SET enabled = coalesce($2, enabled), settings = coalesce($3::jsonb, settings) WHERE kind = $1",
      [kind, body.enabled ?? null, body.settings ? JSON.stringify(body.settings) : null]);
    await audit(tx, ctx, "automation.updated", "automation", kind, body);
    return { ok: true };
  }));

  app.post("/api/automations/:kind/run", async (req) => {
    const { kind } = z.object({ kind: z.string() }).parse(req.params);
    const ctx = await inTenant(req, async (_tx, c) => { requireWrite(c, "finance"); return c; });
    return runAutomation(app, ctx.tenantId, kind, "manual", ctx.userId);
  });

  app.get("/api/automations/runs", (req) => inTenant(req, async (tx) => {
    const q = z.object({ kind: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return tx.query("SELECT * FROM automation_runs WHERE ($1::text IS NULL OR kind = $1) ORDER BY started_at DESC LIMIT $2", [q.kind ?? null, q.limit]);
  }));

  // ---------------------------------------------------------------- bank rules
  app.get("/api/bank/rules", (req) => inTenant(req, (tx) => tx.query(
    `SELECT r.*, a.name AS account_name,
            (SELECT count(*) FROM bank_transactions b JOIN audit_log l ON l.entity_id = b.id::text AND l.action = 'bank.posted'
              WHERE l.data->>'rule' = r.name) AS times_used
       FROM bank_rules r JOIN accounts a ON a.code = r.account_code ORDER BY r.name`)));

  const RuleInput = z.object({
    name: z.string().trim().min(1).max(80), matchText: z.string().trim().min(3).max(80), direction: z.enum(["in", "out", "any"]).default("out"),
    accountCode, vatCode: vatCode.default("OS"), active: z.boolean().default(true),
  });

  app.post("/api/bank/rules", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const r = RuleInput.parse(req.body);
    const [a] = await tx.query<{ is_control: boolean; is_bank: boolean }>("SELECT is_control, is_bank FROM accounts WHERE code = $1 AND NOT archived", [r.accountCode]);
    if (!a || a.is_control || a.is_bank) throw unprocessable("Choose an expense, income or other non-control account");
    const id = newId();
    await tx.query("INSERT INTO bank_rules (id, tenant_id, name, match_text, direction, account_code, vat_code, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, ctx.tenantId, r.name, r.matchText, r.direction, r.accountCode, r.vatCode, r.active]);
    await audit(tx, ctx, "bank_rule.created", "bank_rule", id, r);
    return reply.status(201).send({ id });
  }));

  app.patch("/api/bank/rules/:id", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const { id } = IdParams.parse(req.params);
    const r = RuleInput.partial().parse(req.body);
    const rows = await tx.query(
      `UPDATE bank_rules SET name = coalesce($2, name), match_text = coalesce($3, match_text), direction = coalesce($4, direction),
         account_code = coalesce($5, account_code), vat_code = coalesce($6, vat_code), active = coalesce($7, active) WHERE id = $1 RETURNING id`,
      [id, r.name ?? null, r.matchText ?? null, r.direction ?? null, r.accountCode ?? null, r.vatCode ?? null, r.active ?? null]);
    if (!rows.length) throw notFound("Bank rule");
    await audit(tx, ctx, "bank_rule.updated", "bank_rule", id, r);
    return { ok: true };
  }));

  // ---------------------------------------------------------------- outbox
  app.get("/api/outbox", (req) => inTenant(req, async (tx) => {
    const q = z.object({ relatedId: uuid.optional() }).parse(req.query);
    return tx.query("SELECT * FROM outbox_messages WHERE ($1::uuid IS NULL OR related_id = $1) ORDER BY created_at DESC LIMIT 200", [q.relatedId ?? null]);
  }));

  /** Email an invoice to the customer (kept in the outbox; in demo mode nothing leaves the server). */
  app.post("/api/sales-invoices/:id/email", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const body = z.object({ to: z.email().optional() }).parse(req.body ?? {});
    const [inv] = await tx.query<{ number: string; date: string; due_date: string; total: string; outstanding: string; currency: string;
      customer_name: string; email: string | null; customer_ref: string | null; company_name: string }>(
      `SELECT i.number, i.date::text, i.due_date::text, i.total::text, (i.total - i.amount_paid)::text AS outstanding, i.currency,
              c.name AS customer_name, c.email, i.customer_ref, t.name AS company_name
         FROM sales_invoices i JOIN contacts c ON c.id = i.customer_id CROSS JOIN tenants t WHERE i.id = $1`, [id]);
    if (!inv) throw notFound("Invoice");
    const to = body.to ?? inv.email;
    if (!to) throw unprocessable("This customer has no email address. Add one to the contact or enter one here.");
    return sendEmail(tx, ctx, app.providers, { template: "invoice", to, toName: inv.customer_name, ...invoiceText(inv), relatedType: "sales_invoice", relatedId: id });
  }));
}
