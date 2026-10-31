import { cr, d, dr, finalise, round2, type JournalLine } from "@softilo/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inTenant, requireWrite } from "../lib/context.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { audit, postJournal } from "../lib/ledger.js";
import { accountCode, IdParams, isoDate, money, today } from "../lib/schemas.js";

const AsAt = z.object({ asAt: isoDate.optional() });
const Range = z.object({ from: isoDate, to: isoDate });

export async function registerLedger(app: FastifyInstance) {
  // ---------------------------------------------------------------- chart of accounts
  app.get("/api/accounts", (req) => inTenant(req, (tx) => tx.query(
    `SELECT a.*, coalesce(sum(l.debit), 0) AS debits, coalesce(sum(l.credit), 0) AS credits,
            coalesce(sum(l.debit - l.credit), 0) AS balance
       FROM accounts a LEFT JOIN journal_lines l ON l.account_code = a.code
      GROUP BY a.tenant_id, a.code ORDER BY a.code`)));

  app.post("/api/accounts", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const a = z.object({
      code: accountCode, name: z.string().trim().min(1).max(100),
      type: z.enum(["asset", "liability", "equity", "income", "expense"]),
    }).parse(req.body);
    await tx.query("INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1,$2,$3,$4)", [ctx.tenantId, a.code, a.name, a.type]);
    await audit(tx, ctx, "account.created", "account", a.code, a);
    return reply.status(201).send({ code: a.code });
  }));

  app.patch("/api/accounts/:code", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const { code } = z.object({ code: accountCode }).parse(req.params);
    const body = z.object({ name: z.string().trim().min(1).max(100).optional(), archived: z.boolean().optional() }).parse(req.body);
    const [a] = await tx.query<{ role: string | null }>("SELECT role FROM accounts WHERE code = $1", [code]);
    if (!a) throw notFound("Account");
    if (body.archived && a.role) throw unprocessable("System accounts cannot be archived");
    await tx.query("UPDATE accounts SET name = coalesce($2, name), archived = coalesce($3, archived) WHERE code = $1",
      [code, body.name ?? null, body.archived ?? null]);
    await audit(tx, ctx, "account.updated", "account", code, body);
    return { ok: true };
  }));

  /** Account detail with running balance. */
  app.get("/api/accounts/:code/ledger", (req) => inTenant(req, async (tx) => {
    const { code } = z.object({ code: accountCode }).parse(req.params);
    const q = Range.partial().parse(req.query);
    const [account] = await tx.query("SELECT * FROM accounts WHERE code = $1", [code]);
    if (!account) throw notFound("Account");
    const [opening] = await tx.query<{ balance: string }>(
      `SELECT coalesce(sum(l.debit - l.credit), 0) AS balance FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account_code = $1 AND $2::date IS NOT NULL AND e.date < $2`, [code, q.from ?? null]);
    const lines = await tx.query<{ debit: string; credit: string }>(
      `SELECT e.id AS entry_id, e.number, e.date, e.memo, e.source_type, e.source_id, l.description, l.debit, l.credit
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.account_code = $1 AND ($2::date IS NULL OR e.date >= $2) AND ($3::date IS NULL OR e.date <= $3)
        ORDER BY e.date, e.number, l.line_no LIMIT 5000`, [code, q.from ?? null, q.to ?? null]);
    let running = d(opening!.balance);
    const withBalance = lines.map((l) => {
      running = running.plus(l.debit).minus(l.credit);
      return { ...l, balance: running.toFixed(2) };
    });
    return { account, opening: opening!.balance, lines: withBalance, closing: running.toFixed(2) };
  }));

  // ---------------------------------------------------------------- journals
  app.get("/api/journals", (req) => inTenant(req, async (tx) => {
    const q = z.object({ source: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return tx.query(
      `SELECT e.*, (SELECT sum(debit) FROM journal_lines l WHERE l.entry_id = e.id) AS total, u.name AS created_by_name
         FROM journal_entries e LEFT JOIN users u ON u.id = e.created_by
        WHERE ($1::text IS NULL OR e.source_type = $1) ORDER BY e.date DESC, e.number DESC LIMIT $2`,
      [q.source ?? null, q.limit]);
  }));

  app.get("/api/journals/:id", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const [e] = await tx.query("SELECT e.*, u.name AS created_by_name FROM journal_entries e LEFT JOIN users u ON u.id = e.created_by WHERE e.id = $1", [id]);
    if (!e) throw notFound("Journal");
    const lines = await tx.query(
      `SELECT l.*, a.name AS account_name FROM journal_lines l JOIN accounts a ON a.code = l.account_code
        WHERE l.entry_id = $1 ORDER BY l.line_no`, [id]);
    const vat = await tx.query("SELECT * FROM vat_entries WHERE entry_id = $1", [id]);
    return { ...e, lines, vat };
  }));

  app.post("/api/journals", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const input = z.object({
      date: isoDate,
      memo: z.string().trim().min(1).max(200),
      lines: z.array(z.object({
        accountCode, debit: money.default("0"), credit: money.default("0"), description: z.string().max(200).optional(),
      })).min(2).max(200),
    }).parse(req.body);
    const lines: JournalLine[] = input.lines.map((l) =>
      d(l.debit).isZero() ? cr(l.accountCode, l.credit, l.description) : dr(l.accountCode, round2(d(l.debit).minus(l.credit)), l.description));
    const posting = { journal: finalise({ date: input.date, memo: input.memo, lines }), vat: [] };
    const entry = await postJournal(tx, ctx, posting, { type: "manual" });
    await audit(tx, ctx, "journal.posted", "journal", entry.id, { number: entry.number, memo: input.memo });
    return reply.status(201).send(entry);
  }));

  /** Reverse a manual journal (system postings are corrected through their own documents, e.g. credit notes). */
  app.post("/api/journals/:id/reverse", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const { id } = IdParams.parse(req.params);
    const { date } = z.object({ date: isoDate }).parse(req.body);
    const [e] = await tx.query<{ number: string; memo: string; source_type: string }>(
      "SELECT number, memo, source_type FROM journal_entries WHERE id = $1", [id]);
    if (!e) throw notFound("Journal");
    if (e.source_type !== "manual") throw unprocessable("Only manual journals can be reversed here; correct other postings through their document");
    const [already] = await tx.query("SELECT 1 FROM journal_entries WHERE reverses_id = $1", [id]);
    if (already) throw unprocessable("This journal has already been reversed");
    const lines = await tx.query<{ account_code: string; debit: string; credit: string; description: string | null }>(
      "SELECT account_code, debit, credit, description FROM journal_lines WHERE entry_id = $1 ORDER BY line_no", [id]);
    const reversed = lines.map((l) => ({ account: l.account_code, debit: d(l.credit), credit: d(l.debit), description: l.description ?? undefined }));
    const entry = await postJournal(tx, ctx, { journal: finalise({ date, memo: `Reversal of ${e.number}: ${e.memo}`, lines: reversed }), vat: [] },
      { type: "manual", reverses: id });
    await audit(tx, ctx, "journal.reversed", "journal", id, { reversal: entry.number });
    return reply.status(201).send(entry);
  }));

  app.get("/api/audit", (req) => inTenant(req, async (tx) => {
    const q = z.object({ entity: z.string().optional(), entityId: z.string().optional() }).parse(req.query);
    return tx.query(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.data, a.ip, a.at, a.hash, u.name AS user_name
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE ($1::text IS NULL OR a.entity = $1) AND ($2::text IS NULL OR a.entity_id = $2)
        ORDER BY a.id DESC LIMIT 500`, [q.entity ?? null, q.entityId ?? null]);
  }));

  // ---------------------------------------------------------------- reports
  app.get("/api/reports/trial-balance", (req) => inTenant(req, async (tx) => {
    const { asAt = today() } = AsAt.parse(req.query);
    const rows = await tx.query<{ debit: string; credit: string }>(
      `SELECT a.code, a.name, a.type,
              greatest(sum(l.debit - l.credit), 0) AS debit, greatest(sum(l.credit - l.debit), 0) AS credit
         FROM accounts a JOIN journal_lines l ON l.account_code = a.code JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.date <= $1 GROUP BY a.code, a.name, a.type HAVING sum(l.debit - l.credit) <> 0 ORDER BY a.code`, [asAt]);
    const debit = rows.reduce((s, r) => s.plus(r.debit), d(0));
    const credit = rows.reduce((s, r) => s.plus(r.credit), d(0));
    return { asAt, rows, totals: { debit: debit.toFixed(2), credit: credit.toFixed(2) }, balanced: debit.equals(credit) };
  }));

  app.get("/api/reports/profit-and-loss", (req) => inTenant(req, async (tx) => {
    const { from, to } = Range.parse(req.query);
    const rows = await tx.query<{ code: string; name: string; type: string; role: string | null; amount: string }>(
      `SELECT a.code, a.name, a.type, a.role,
              CASE WHEN a.type = 'income' THEN sum(l.credit - l.debit) ELSE sum(l.debit - l.credit) END AS amount
         FROM accounts a JOIN journal_lines l ON l.account_code = a.code JOIN journal_entries e ON e.id = l.entry_id
        WHERE a.type IN ('income','expense') AND e.date BETWEEN $1 AND $2
        GROUP BY a.code, a.name, a.type, a.role HAVING sum(l.debit - l.credit) <> 0 ORDER BY a.code`, [from, to]);
    const income = rows.filter((r) => r.type === "income");
    const costOfSales = rows.filter((r) => r.type === "expense" && r.code < "7000");
    const overheads = rows.filter((r) => r.type === "expense" && r.code >= "7000");
    const total = (rs: typeof rows) => rs.reduce((s, r) => s.plus(r.amount), d(0));
    const grossProfit = total(income).minus(total(costOfSales));
    const netProfit = grossProfit.minus(total(overheads));
    return {
      from, to, income, costOfSales, overheads,
      totals: {
        income: total(income).toFixed(2), costOfSales: total(costOfSales).toFixed(2), grossProfit: grossProfit.toFixed(2),
        overheads: total(overheads).toFixed(2), netProfit: netProfit.toFixed(2),
        grossMargin: total(income).isZero() ? null : grossProfit.dividedBy(total(income)).times(100).toFixed(1),
      },
    };
  }));

  app.get("/api/reports/balance-sheet", (req) => inTenant(req, async (tx) => {
    const { asAt = today() } = AsAt.parse(req.query);
    const rows = await tx.query<{ code: string; name: string; type: string; amount: string }>(
      `SELECT a.code, a.name, a.type,
              CASE WHEN a.type = 'asset' THEN sum(l.debit - l.credit) ELSE sum(l.credit - l.debit) END AS amount
         FROM accounts a JOIN journal_lines l ON l.account_code = a.code JOIN journal_entries e ON e.id = l.entry_id
        WHERE a.type IN ('asset','liability','equity') AND e.date <= $1
        GROUP BY a.code, a.name, a.type HAVING sum(l.debit - l.credit) <> 0 ORDER BY a.code`, [asAt]);
    const [pl] = await tx.query<{ profit: string }>(
      `SELECT coalesce(sum(l.credit - l.debit), 0) AS profit FROM journal_lines l
         JOIN accounts a ON a.code = l.account_code JOIN journal_entries e ON e.id = l.entry_id
        WHERE a.type IN ('income','expense') AND e.date <= $1`, [asAt]);
    const sumOf = (t: string) => rows.filter((r) => r.type === t).reduce((s, r) => s.plus(r.amount), d(0));
    const assets = sumOf("asset");
    const liabilities = sumOf("liability");
    const equity = sumOf("equity").plus(pl!.profit);
    return {
      asAt,
      assets: rows.filter((r) => r.type === "asset"),
      liabilities: rows.filter((r) => r.type === "liability"),
      equity: [...rows.filter((r) => r.type === "equity"), { code: "", name: "Profit and loss to date", type: "equity", amount: d(pl!.profit).toFixed(2) }],
      totals: {
        assets: assets.toFixed(2), liabilities: liabilities.toFixed(2), netAssets: assets.minus(liabilities).toFixed(2),
        equity: equity.toFixed(2),
      },
      balanced: assets.minus(liabilities).equals(equity),
    };
  }));

  for (const [path, table, party, kind] of [
    ["aged-debtors", "sales_invoices", "customer_id", "invoice"],
    ["aged-creditors", "supplier_bills", "supplier_id", "bill"],
  ] as const) {
    app.get(`/api/reports/${path}`, (req) => inTenant(req, async (tx) => {
      const { asAt = today() } = AsAt.parse(req.query);
      const rows = await tx.query(
        `SELECT c.id, c.name, x.currency,
                sum(o) AS total,
                sum(o) FILTER (WHERE x.due_date >= $1) AS current,
                sum(o) FILTER (WHERE $1 - x.due_date BETWEEN 1 AND 30) AS d1_30,
                sum(o) FILTER (WHERE $1 - x.due_date BETWEEN 31 AND 60) AS d31_60,
                sum(o) FILTER (WHERE $1 - x.due_date BETWEEN 61 AND 90) AS d61_90,
                sum(o) FILTER (WHERE $1 - x.due_date > 90) AS d90_plus
           FROM (SELECT ${party} AS contact_id, currency, due_date,
                        CASE WHEN kind = '${kind}' THEN total - amount_paid ELSE -(total - amount_paid) END AS o
                   FROM ${table} WHERE date <= $1) x
           JOIN contacts c ON c.id = x.contact_id
          WHERE x.o <> 0 GROUP BY c.id, c.name, x.currency ORDER BY sum(o) DESC`, [asAt]);
      return { asAt, rows };
    }));
  }

  app.get("/api/reports/stock-valuation", (req) => inTenant(req, async (tx) => {
    const rows = await tx.query(
      `SELECT p.id, p.sku, p.name, w.code AS warehouse, b.quantity, b.value,
              CASE WHEN b.quantity > 0 THEN round(b.value / b.quantity, 6) ELSE 0 END AS average_cost
         FROM stock_balances b JOIN products p ON p.id = b.product_id JOIN warehouses w ON w.id = b.warehouse_id
        WHERE b.quantity <> 0 ORDER BY p.sku, w.code`);
    const checks = await integrity(tx);
    return { rows, ...checks.stock };
  }));

  /** Sub-ledger vs. control account checks; these should always agree. */
  async function integrity(tx: import("@softilo/db").Sql) {
    const [s] = await tx.query<{ stock: string; ledger: string }>(
      `SELECT (SELECT coalesce(sum(value), 0) FROM stock_balances) AS stock,
              (SELECT coalesce(sum(debit - credit), 0) FROM journal_lines l JOIN accounts a ON a.code = l.account_code WHERE a.role = 'stock') AS ledger`);
    const [g] = await tx.query<{ unbilled: string; ledger: string }>(
      `SELECT (SELECT coalesce(sum(value_gbp), 0) FROM goods_receipt_lines WHERE NOT billed) AS unbilled,
              (SELECT coalesce(sum(credit - debit), 0) FROM journal_lines l JOIN accounts a ON a.code = l.account_code WHERE a.role = 'grni') AS ledger`);
    const [m] = await tx.query<{ movements: string; balances: string }>(
      `SELECT (SELECT coalesce(sum(value), 0) FROM stock_movements) AS movements, (SELECT coalesce(sum(value), 0) FROM stock_balances) AS balances`);
    const [tb] = await tx.query<{ diff: string }>("SELECT coalesce(sum(debit - credit), 0) AS diff FROM journal_lines");
    return {
      stock: { stockValue: s!.stock, ledgerValue: s!.ledger, difference: d(s!.stock).minus(s!.ledger).toFixed(2), reconciled: d(s!.stock).equals(s!.ledger) },
      grni: { unbilledReceipts: g!.unbilled, ledgerValue: g!.ledger, reconciled: d(g!.unbilled).equals(g!.ledger) },
      projection: { movements: m!.movements, balances: m!.balances, reconciled: d(m!.movements).equals(m!.balances) },
      trialBalance: { difference: tb!.diff, reconciled: d(tb!.diff).isZero() },
    };
  }

  app.get("/api/reports/integrity", (req) => inTenant(req, async (tx) => {
    const checks = await integrity(tx);
    return { ...checks, allReconciled: Object.values(checks).every((c) => c.reconciled) };
  }));

  app.get("/api/dashboard", (req) => inTenant(req, async (tx) => {
    const bal = async (role: string, sign = 1) => {
      const [r] = await tx.query<{ v: string }>(
        `SELECT coalesce(sum(debit - credit), 0) * $2 AS v FROM journal_lines l JOIN accounts a ON a.code = l.account_code WHERE a.role = $1`, [role, sign]);
      return r!.v;
    };
    const [cash] = await tx.query<{ v: string }>(
      "SELECT coalesce(sum(debit - credit), 0) AS v FROM journal_lines l JOIN accounts a ON a.code = l.account_code WHERE a.is_bank");
    const monthly = await tx.query(
      `SELECT to_char(date_trunc('month', e.date), 'YYYY-MM') AS month,
              sum(l.credit - l.debit) FILTER (WHERE a.type = 'income') AS sales,
              sum(l.debit - l.credit) FILTER (WHERE a.role IN ('cogs','ppv')) AS cost_of_sales
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.code = l.account_code
        WHERE e.date >= date_trunc('month', current_date) - interval '5 months'
        GROUP BY 1 ORDER BY 1`);
    const [overdue] = await tx.query<{ n: string; v: string }>(
      `SELECT count(*) AS n, coalesce(sum(total_gbp - amount_paid * rate), 0) AS v FROM sales_invoices
        WHERE kind = 'invoice' AND amount_paid < total AND due_date < current_date`);
    const lowStock = await tx.query(
      `SELECT p.id, p.sku, p.name, coalesce(sum(b.quantity), 0) AS on_hand, p.reorder_level FROM products p
         LEFT JOIN stock_balances b ON b.product_id = p.id
        WHERE p.track_stock AND NOT p.archived AND p.reorder_level IS NOT NULL
        GROUP BY p.id HAVING coalesce(sum(b.quantity), 0) <= p.reorder_level ORDER BY p.sku LIMIT 10`);
    const [unrec] = await tx.query<{ n: string }>("SELECT count(*) AS n FROM bank_transactions WHERE status = 'unreconciled'");
    const recent = await tx.query("SELECT id, number, date, memo, source_type FROM journal_entries ORDER BY date DESC, number DESC LIMIT 8");
    const vatOutput = await bal("vat_output", -1);
    const vatInput = await bal("vat_input");
    return {
      cash: cash!.v,
      receivables: await bal("debtors"),
      payables: await bal("creditors", -1),
      stock: await bal("stock"),
      vatDue: d(vatOutput).minus(vatInput).toFixed(2),
      overdue: { count: Number(overdue!.n), value: d(overdue!.v).toFixed(2) },
      unreconciled: Number(unrec!.n),
      monthly, lowStock, recent,
    };
  }));
}
