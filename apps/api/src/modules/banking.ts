import { createHash } from "node:crypto";
import { newId } from "@softilo/db";
import { d, postBankEntry } from "@softilo/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inTenant, requireWrite } from "../lib/context.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { assertAccount, audit, loadRoles, postJournal } from "../lib/ledger.js";
import { accountCode, IdParams, uuid, vatCode } from "../lib/schemas.js";
import { createPayment, PaymentInput } from "./sales.js";

export interface ParsedBankLine {
  date: string;
  description: string;
  reference: string | null;
  amount: string;
}

/** Split one CSV line, honouring quoted fields. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function parseDate(s: string): string {
  const uk = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (uk) {
    const year = uk[3]!.length === 2 ? `20${uk[3]}` : uk[3]!;
    return `${year}-${uk[2]!.padStart(2, "0")}-${uk[1]!.padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  throw new Error(`Unrecognised date "${s}" (use DD/MM/YYYY or YYYY-MM-DD)`);
}

function parseAmount(s: string): number {
  const clean = s.replace(/[£,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (clean === "") return 0;
  if (!/^-?\d+(\.\d{1,2})?$/.test(clean)) throw new Error(`Unrecognised amount "${s}"`);
  return Math.round(Number(clean) * 100);
}

/**
 * Parse a bank statement CSV as exported by UK banks. Needs a header row with a date column,
 * a description column, and either an amount column or separate money in / money out columns.
 */
export function parseBankCsv(content: string): ParsedBankLine[] {
  const rows = content.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (rows.length < 2) throw new Error("The file has no transactions");
  const header = splitCsv(rows[0]!).map((h) => h.toLowerCase());
  const find = (...names: string[]) => header.findIndex((h) => names.some((n) => h === n || h.includes(n)));
  const iDate = find("date");
  const iDesc = find("description", "details", "narrative", "memo", "payee");
  const iRef = find("reference", "ref");
  const iAmount = header.findIndex((h) => h === "amount" || h === "value");
  const iIn = find("paid in", "money in", "credit");
  const iOut = find("paid out", "money out", "debit");
  if (iDate < 0 || iDesc < 0 || (iAmount < 0 && (iIn < 0 || iOut < 0))) {
    throw new Error("The CSV needs Date, Description and Amount (or Paid in / Paid out) columns");
  }
  return rows.slice(1).map((row, i) => {
    const cells = splitCsv(row);
    try {
      const pence = iAmount >= 0
        ? parseAmount(cells[iAmount] ?? "")
        : parseAmount(cells[iIn] ?? "") - Math.abs(parseAmount(cells[iOut] ?? ""));
      return {
        date: parseDate(cells[iDate] ?? ""),
        description: cells[iDesc] ?? "",
        reference: iRef >= 0 ? cells[iRef] || null : null,
        amount: (pence / 100).toFixed(2),
      };
    } catch (e) {
      throw new Error(`Row ${i + 2}: ${(e as Error).message}`);
    }
  }).filter((l) => l.amount !== "0.00");
}

export async function registerBanking(app: FastifyInstance) {
  app.get("/api/bank-accounts", (req) => inTenant(req, (tx) => tx.query(
    `SELECT a.code, a.name,
            coalesce((SELECT sum(debit - credit) FROM journal_lines l WHERE l.account_code = a.code), 0) AS balance,
            (SELECT count(*) FROM bank_transactions b WHERE b.bank_account_code = a.code AND b.status = 'unreconciled') AS unreconciled,
            (SELECT coalesce(sum(amount), 0) FROM bank_transactions b WHERE b.bank_account_code = a.code) AS statement_balance
       FROM accounts a WHERE a.is_bank AND NOT a.archived ORDER BY a.code`)));

  app.post("/api/bank-accounts", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const b = z.object({ code: accountCode, name: z.string().trim().min(1).max(100) }).parse(req.body);
    await tx.query("INSERT INTO accounts (tenant_id, code, name, type, is_bank) VALUES ($1,$2,$3,'asset',true)", [ctx.tenantId, b.code, b.name]);
    await audit(tx, ctx, "bank_account.created", "account", b.code, b);
    return reply.status(201).send({ code: b.code });
  }));

  app.post("/api/bank/import", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const input = z.object({ bankAccountCode: accountCode, content: z.string().min(1).max(5_000_000) }).parse(req.body);
    await assertAccount(tx, input.bankAccountCode, { bank: true });
    let lines: ParsedBankLine[];
    try { lines = parseBankCsv(input.content); } catch (e) { throw unprocessable((e as Error).message); }
    // Identical lines on the same day are legitimate (two £5 charges), so the hash includes the occurrence count.
    const seen = new Map<string, number>();
    let imported = 0;
    for (const l of lines) {
      const key = `${l.date}|${l.amount}|${l.description}|${l.reference ?? ""}`;
      const occurrence = (seen.get(key) ?? 0) + 1;
      seen.set(key, occurrence);
      const hash = createHash("sha256").update(`${key}|${occurrence}`).digest("hex");
      const rows = await tx.query(
        `INSERT INTO bank_transactions (id, tenant_id, bank_account_code, date, description, reference, amount, import_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id, bank_account_code, import_hash) DO NOTHING RETURNING id`,
        [newId(), ctx.tenantId, input.bankAccountCode, l.date, l.description, l.reference, l.amount, hash]);
      imported += rows.length;
    }
    await audit(tx, ctx, "bank.imported", "account", input.bankAccountCode, { lines: lines.length, imported });
    return { lines: lines.length, imported, duplicates: lines.length - imported };
  }));

  app.get("/api/bank/transactions", (req) => inTenant(req, async (tx) => {
    const q = z.object({ account: accountCode.optional(), status: z.enum(["unreconciled", "reconciled"]).optional() }).parse(req.query);
    return tx.query(
      `SELECT b.*, p.number AS payment_number, e.number AS journal_number FROM bank_transactions b
         LEFT JOIN payments p ON p.id = b.payment_id LEFT JOIN journal_entries e ON e.id = b.entry_id
        WHERE ($1::text IS NULL OR b.bank_account_code = $1) AND ($2::text IS NULL OR b.status = $2)
        ORDER BY b.date DESC, b.created_at DESC LIMIT 500`,
      [q.account ?? null, q.status ?? null]);
  }));

  /** Likely matches: unreconciled payments for the same amount, then open invoices/bills for the same amount. */
  app.get("/api/bank/transactions/:id/suggestions", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const [b] = await tx.query<{ amount: string; date: string; bank_account_code: string }>(
      "SELECT amount, date, bank_account_code FROM bank_transactions WHERE id = $1", [id]);
    if (!b) throw notFound("Bank transaction");
    const moneyIn = Number(b.amount) > 0;
    const payments = await tx.query(
      `SELECT p.id, p.number, p.date, p.amount, c.name AS contact_name FROM payments p JOIN contacts c ON c.id = p.contact_id
        WHERE p.bank_account_code = $1 AND p.direction = $2 AND round(p.amount * p.rate, 2) = abs($3::numeric)
          AND NOT EXISTS (SELECT 1 FROM bank_transactions x WHERE x.payment_id = p.id)
        ORDER BY abs(p.date - $4::date) LIMIT 5`,
      [b.bank_account_code, moneyIn ? "receipt" : "payment", b.amount, b.date]);
    const documents = moneyIn
      ? await tx.query(
        `SELECT i.id, i.number, i.date, i.total - i.amount_paid AS outstanding, c.id AS contact_id, c.name AS contact_name, 'sales_invoice' AS type
           FROM sales_invoices i JOIN contacts c ON c.id = i.customer_id
          WHERE i.kind = 'invoice' AND i.currency = 'GBP' AND i.total - i.amount_paid = $1::numeric ORDER BY i.date LIMIT 5`, [b.amount])
      : await tx.query(
        `SELECT s.id, s.number, s.supplier_ref, s.date, s.total - s.amount_paid AS outstanding, c.id AS contact_id, c.name AS contact_name, 'supplier_bill' AS type
           FROM supplier_bills s JOIN contacts c ON c.id = s.supplier_id
          WHERE s.kind = 'bill' AND s.currency = 'GBP' AND s.total - s.amount_paid = abs($1::numeric) ORDER BY s.date LIMIT 5`, [b.amount]);
    return { payments, documents };
  }));

  async function loadUnreconciled(tx: import("@softilo/db").Sql, id: string) {
    const [b] = await tx.query<{ amount: string; date: string; bank_account_code: string; description: string; reference: string | null; status: string }>(
      "SELECT amount, date, bank_account_code, description, reference, status FROM bank_transactions WHERE id = $1 FOR UPDATE", [id]);
    if (!b) throw notFound("Bank transaction");
    if (b.status !== "unreconciled") throw unprocessable("This bank line is already reconciled");
    return b;
  }

  /** Match to an existing payment or receipt. */
  app.post("/api/bank/transactions/:id/match", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const { id } = IdParams.parse(req.params);
    const { paymentId } = z.object({ paymentId: uuid }).parse(req.body);
    const b = await loadUnreconciled(tx, id);
    // Compare in GBP: a foreign-currency payment leaves the bank as its sterling equivalent.
    const [p] = await tx.query<{ gbp: string; direction: string; bank_account_code: string }>(
      "SELECT round(amount * rate, 2) AS gbp, direction, bank_account_code FROM payments WHERE id = $1", [paymentId]);
    if (!p) throw notFound("Payment");
    const signed = p.direction === "receipt" ? d(p.gbp) : d(p.gbp).neg();
    if (p.bank_account_code !== b.bank_account_code || !signed.equals(b.amount)) {
      throw unprocessable("The payment's bank account or amount does not match this bank line");
    }
    const [used] = await tx.query("SELECT 1 FROM bank_transactions WHERE payment_id = $1", [paymentId]);
    if (used) throw unprocessable("That payment is already matched to another bank line");
    await tx.query("UPDATE bank_transactions SET status = 'reconciled', payment_id = $2 WHERE id = $1", [id, paymentId]);
    await audit(tx, ctx, "bank.matched", "bank_transaction", id, { paymentId });
    return { ok: true };
  }));

  /** Create a customer receipt / supplier payment from the bank line and reconcile it. */
  app.post("/api/bank/transactions/:id/payment", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const { id } = IdParams.parse(req.params);
    const b = await loadUnreconciled(tx, id);
    const body = z.object({ contactId: uuid, allocations: z.array(z.object({ documentId: uuid, amount: z.string() })).default([]) }).parse(req.body);
    const moneyIn = Number(b.amount) > 0;
    const payment = await createPayment(tx, ctx, PaymentInput.parse({
      direction: moneyIn ? "receipt" : "payment", contactId: body.contactId, date: b.date, bankAccountCode: b.bank_account_code,
      currency: "GBP", amount: b.amount.replace("-", ""), reference: b.reference ?? b.description, allocations: body.allocations,
    }));
    await tx.query("UPDATE bank_transactions SET status = 'reconciled', payment_id = $2 WHERE id = $1", [id, payment.id]);
    await audit(tx, ctx, "bank.reconciled", "bank_transaction", id, { paymentId: payment.id });
    return payment;
  }));

  /** Code the bank line straight to an account (bank charges, rent, interest). */
  app.post("/api/bank/transactions/:id/post", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const { id } = IdParams.parse(req.params);
    const body = z.object({ accountCode, vatCode: vatCode.default("OS"), description: z.string().max(200).optional() }).parse(req.body);
    const b = await loadUnreconciled(tx, id);
    const [a] = await tx.query<{ is_control: boolean; is_bank: boolean }>("SELECT is_control, is_bank FROM accounts WHERE code = $1", [body.accountCode]);
    if (!a || a.is_control) throw unprocessable("Choose a non-control account");
    let posting;
    try {
      posting = postBankEntry(await loadRoles(tx), {
        date: b.date, reference: b.reference ?? b.description, bankAccount: b.bank_account_code, gross: b.amount,
        account: body.accountCode, vatCode: body.vatCode, description: body.description ?? b.description,
      });
    } catch (e) { throw unprocessable((e as Error).message); }
    const entry = await postJournal(tx, ctx, posting, { type: "bank_transaction", id });
    await tx.query("UPDATE bank_transactions SET status = 'reconciled', entry_id = $2 WHERE id = $1", [id, entry.id]);
    await audit(tx, ctx, "bank.posted", "bank_transaction", id, body);
    return { entry: entry.number };
  }));
}
