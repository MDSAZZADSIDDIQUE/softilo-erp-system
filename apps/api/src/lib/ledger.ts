import { createHash } from "node:crypto";
import { newId, type Sql } from "@softilo/db";
import { toFixed, type Posting, type RoleMap } from "@softilo/domain";
import type { Ctx } from "./context.js";
import { unprocessable } from "./errors.js";

const PREFIXES: Record<string, string> = {
  journal: "JNL", purchase_order: "PO", goods_receipt: "GRN", supplier_bill: "BILL", sales_invoice: "INV",
  credit_note: "CN", supplier_credit: "SCN", payment: "PAY", receipt: "REC", shipment: "SHP",
};

/** Gap-free document numbering per tenant: the counter row is locked for the transaction. */
export async function nextNumber(tx: Sql, ctx: Ctx, kind: keyof typeof PREFIXES): Promise<string> {
  const prefix = PREFIXES[kind]!;
  const [row] = await tx.query<{ value: string }>(
    `INSERT INTO number_sequences (tenant_id, kind, prefix, next_value) VALUES ($1, $2, $3, 2)
     ON CONFLICT (tenant_id, kind) DO UPDATE SET next_value = number_sequences.next_value + 1
     RETURNING next_value - 1 AS value`,
    [ctx.tenantId, kind, prefix],
  );
  return `${prefix}-${String(row!.value).padStart(5, "0")}`;
}

export async function loadRoles(tx: Sql): Promise<RoleMap> {
  const rows = await tx.query<{ role: string; code: string }>("SELECT role, code FROM accounts WHERE role IS NOT NULL");
  return Object.fromEntries(rows.map((r) => [r.role, r.code])) as RoleMap;
}

/**
 * Write a domain posting to the ledger: entry, lines and VAT entries, in the caller's transaction.
 * The database re-checks the balance at commit.
 */
export async function postJournal(
  tx: Sql, ctx: Ctx, posting: Posting, source: { type: string; id?: string; reverses?: string; entryId?: string },
): Promise<{ id: string; number: string }> {
  const id = source.entryId ?? newId();
  const number = await nextNumber(tx, ctx, "journal");
  await tx.query(
    `INSERT INTO journal_entries (id, tenant_id, number, date, memo, source_type, source_id, reverses_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, ctx.tenantId, number, posting.journal.date, posting.journal.memo, source.type, source.id ?? null,
      source.reverses ?? null, ctx.userId],
  );
  let n = 1;
  for (const l of posting.journal.lines) {
    await tx.query(
      `INSERT INTO journal_lines (id, tenant_id, entry_id, line_no, account_code, debit, credit, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId(), ctx.tenantId, id, n++, l.account, toFixed(l.debit), toFixed(l.credit), l.description ?? null],
    );
  }
  for (const v of posting.vat) {
    if (v.net.isZero() && v.vat.isZero()) continue;
    await tx.query(
      `INSERT INTO vat_entries (id, tenant_id, entry_id, date, direction, vat_code, net, vat) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId(), ctx.tenantId, id, posting.journal.date, v.direction, v.code, toFixed(v.net), toFixed(v.vat)],
    );
  }
  return { id, number };
}

/** Append to the tenant's hash-chained audit log. */
export async function audit(tx: Sql, ctx: Ctx, action: string, entity: string, entityId: string | null, data: unknown = {}) {
  const [prev] = await tx.query<{ hash: string }>("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1");
  const prevHash = prev?.hash ?? "genesis";
  const at = new Date().toISOString();
  const payload = JSON.stringify({ prevHash, tenant: ctx.tenantId, user: ctx.userId, action, entity, entityId, data, at });
  const hash = createHash("sha256").update(payload).digest("hex");
  await tx.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, data, ip, at, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [ctx.tenantId, ctx.userId, action, entity, entityId, JSON.stringify(data), ctx.ip ?? null, at, prevHash, hash],
  );
}

export async function assertAccount(tx: Sql, code: string, opts: { bank?: boolean } = {}) {
  const [a] = await tx.query<{ is_bank: boolean; archived: boolean }>("SELECT is_bank, archived FROM accounts WHERE code = $1", [code]);
  if (!a || a.archived) throw unprocessable(`Account ${code} does not exist`);
  if (opts.bank && !a.is_bank) throw unprocessable(`Account ${code} is not a bank account`);
}
