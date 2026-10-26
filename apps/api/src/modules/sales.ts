import { newId, type Sql } from "@softilo/db";
import { chargedVat, d, postPayment, postSalesInvoice, round2, toFixed, type Dec, type SalesLine } from "@softilo/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inTenant, requireWrite, type Ctx } from "../lib/context.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { assertAccount, audit, loadRoles, nextNumber, postJournal } from "../lib/ledger.js";
import { accountCode, addDays, checkRate, currency, IdParams, isoDate, positiveMoney, quantity, rate, unitPrice, uuid, vatCode } from "../lib/schemas.js";
import { position, stockIn, stockOut } from "../lib/stock.js";

export const InvoiceInput = z.object({
  customerId: uuid,
  date: isoDate,
  dueDate: isoDate.optional(),
  currency: currency.optional(),
  rate: rate.optional(),
  warehouseId: uuid.optional(),
  customerRef: z.string().max(60).optional(),
  creditsId: uuid.optional(),
  lines: z.array(z.object({
    productId: uuid.optional(),
    description: z.string().max(500).optional(),
    quantity,
    unitPrice,
    vatCode: vatCode.optional(),
    accountCode: accountCode.optional(),
    /** Credit notes only: put the goods back into stock. */
    returnToStock: z.boolean().optional(),
  })).min(1).max(500),
});

export const PaymentInput = z.object({
  direction: z.enum(["receipt", "payment"]),
  contactId: uuid,
  date: isoDate,
  bankAccountCode: accountCode,
  currency: currency.optional(),
  rate: rate.optional(),
  amount: positiveMoney,
  reference: z.string().max(100).optional(),
  allocations: z.array(z.object({ documentId: uuid, amount: positiveMoney })).default([]),
});

async function customer(tx: Sql, id: string) {
  const [c] = await tx.query<{ id: string; currency: string; payment_terms_days: number; kind: string }>(
    "SELECT id, currency, payment_terms_days, kind FROM contacts WHERE id = $1 AND NOT archived", [id]);
  if (!c || c.kind === "supplier") throw unprocessable("Customer not found");
  return c;
}

export async function createSalesDocument(tx: Sql, ctx: Ctx, kind: "invoice" | "credit", input: z.infer<typeof InvoiceInput>) {
  const cust = await customer(tx, input.customerId);
  const cur = input.currency ?? cust.currency;
  const r = checkRate(cur, input.rate);
  const sign = kind === "credit" ? -1 : 1;
  const roles = await loadRoles(tx);
  const [w] = input.warehouseId
    ? await tx.query<{ id: string }>("SELECT id FROM warehouses WHERE id = $1", [input.warehouseId])
    : await tx.query<{ id: string }>("SELECT id FROM warehouses ORDER BY code = 'MAIN' DESC, code LIMIT 1");
  if (!w) throw unprocessable("Warehouse not found");

  let original: { id: string; customer_id: string } | undefined;
  if (input.creditsId) {
    if (kind !== "credit") throw unprocessable("Only credit notes can reference an invoice");
    [original] = await tx.query<{ id: string; customer_id: string }>(
      "SELECT id, customer_id FROM sales_invoices WHERE id = $1 AND kind = 'invoice'", [input.creditsId]);
    if (!original || original.customer_id !== cust.id) throw unprocessable("The credited invoice was not found for this customer");
  }

  const id = newId();
  const entryId = newId();
  const number = await nextNumber(tx, ctx, kind === "credit" ? "credit_note" : "sales_invoice");
  const src = { date: input.date, sourceType: "sales_invoice", sourceId: id, entryId };
  const domainLines: SalesLine[] = [];
  const stored: unknown[][] = [];
  let n = 1;
  for (const l of input.lines) {
    type ProductRow = { id: string; name: string; sales_vat_code: string; track_stock: boolean };
    let product: ProductRow | undefined;
    if (l.productId) {
      [product] = await tx.query<ProductRow>("SELECT id, name, sales_vat_code, track_stock FROM products WHERE id = $1 AND NOT archived", [l.productId]);
      if (!product) throw unprocessable("Product not found");
    }
    const code = (l.vatCode ?? product?.sales_vat_code ?? "S20") as SalesLine["vatCode"];
    const net = round2(d(l.quantity).times(l.unitPrice));
    const account = l.accountCode ?? roles.sales;
    await assertAccount(tx, account);
    let cost: Dec | undefined;
    if (product?.track_stock) {
      if (kind === "invoice") {
        cost = await stockOut(tx, ctx, product.id, w.id, l.quantity, src);
      } else if (l.returnToStock) {
        // Returned goods go back at the cost they left at (original invoice), else current average cost.
        const [orig] = original
          ? await tx.query<{ unit: string }>(
            "SELECT cost_gbp / quantity AS unit FROM sales_invoice_lines WHERE invoice_id = $1 AND product_id = $2 AND quantity > 0 LIMIT 1",
            [original.id, product.id])
          : [];
        const pos = await position(tx, product.id, w.id);
        const unit = orig?.unit ?? (pos.quantity.isZero() ? undefined : pos.value.dividedBy(pos.quantity).toString());
        if (unit === undefined) throw unprocessable(`No cost is known for returned "${product.name}"`);
        cost = round2(d(l.quantity).times(unit));
        await stockIn(tx, ctx, product.id, w.id, l.quantity, cost, "return", src);
      }
    }
    const description = l.description ?? product?.name ?? "";
    if (!description) throw unprocessable("Each line needs a description or a product");
    domainLines.push({ net, vatCode: code, account, costGbp: cost, description });
    const vat = chargedVat(net, code);
    stored.push([newId(), ctx.tenantId, id, n++, product?.id ?? null, description, l.quantity, l.unitPrice,
      toFixed(net), code, toFixed(vat), account, toFixed(cost ?? 0)]);
  }

  const posting = postSalesInvoice(roles, { date: input.date, reference: number, rate: r, sign, lines: domainLines });
  await postJournal(tx, ctx, posting, { type: "sales_invoice", id, entryId });
  await tx.query(
    `INSERT INTO sales_invoices (id, tenant_id, number, kind, customer_id, warehouse_id, customer_ref, date, due_date, currency, rate,
       total, total_gbp, credits_id, entry_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [id, ctx.tenantId, number, kind, cust.id, w.id, input.customerRef ?? null, input.date,
      input.dueDate ?? addDays(input.date, kind === "credit" ? 0 : cust.payment_terms_days), cur, r,
      toFixed(posting.total.abs()), toFixed(posting.totalGbp.abs()), original?.id ?? null, entryId],
  );
  for (const row of stored) {
    await tx.query(
      `INSERT INTO sales_invoice_lines (id, tenant_id, invoice_id, line_no, product_id, description, quantity, unit_price, net,
         vat_code, vat, account_code, cost_gbp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, row);
  }
  await audit(tx, ctx, `sales_${kind}.posted`, "sales_invoice", id, { number, total: toFixed(posting.total.abs()), currency: cur });
  return { id, number };
}

/** Customer receipt or supplier payment, allocated to open documents. */
export async function createPayment(tx: Sql, ctx: Ctx, input: z.infer<typeof PaymentInput>) {
  const [contact] = await tx.query<{ currency: string }>("SELECT currency FROM contacts WHERE id = $1", [input.contactId]);
  if (!contact) throw unprocessable("Contact not found");
  await assertAccount(tx, input.bankAccountCode, { bank: true });
  const cur = input.currency ?? contact.currency;
  const r = checkRate(cur, input.rate);
  const table = input.direction === "receipt" ? "sales_invoices" : "supplier_bills";
  const party = input.direction === "receipt" ? "customer_id" : "supplier_id";
  const docKind = input.direction === "receipt" ? "invoice" : "bill";
  const allocs: { amount: string; documentRate: string }[] = [];
  for (const a of input.allocations) {
    const [doc] = await tx.query<{ total: string; amount_paid: string; rate: string; currency: string; number: string }>(
      `SELECT total, amount_paid, rate, currency, number FROM ${table} WHERE id = $1 AND ${party} = $2 AND kind = $3 FOR UPDATE`,
      [a.documentId, input.contactId, docKind]);
    if (!doc) throw unprocessable("An allocated document was not found for this contact");
    if (doc.currency !== cur) throw unprocessable(`${doc.number} is in ${doc.currency}`);
    const outstanding = d(doc.total).minus(doc.amount_paid);
    if (d(a.amount).greaterThan(outstanding)) throw unprocessable(`Only ${outstanding.toFixed(2)} is outstanding on ${doc.number}`);
    await tx.query(`UPDATE ${table} SET amount_paid = amount_paid + $2 WHERE id = $1`, [a.documentId, a.amount]);
    allocs.push({ amount: a.amount, documentRate: doc.rate });
  }
  const id = newId();
  const number = await nextNumber(tx, ctx, input.direction === "receipt" ? "receipt" : "payment");
  const posting = postPayment(await loadRoles(tx), {
    date: input.date, reference: input.reference ? `${number} ${input.reference}` : number, direction: input.direction,
    bankAccount: input.bankAccountCode, amount: input.amount, rate: r, allocations: allocs,
  });
  const entry = await postJournal(tx, ctx, posting, { type: "payment", id });
  await tx.query(
    `INSERT INTO payments (id, tenant_id, number, direction, contact_id, bank_account_code, date, currency, rate, amount, reference, entry_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, ctx.tenantId, number, input.direction, input.contactId, input.bankAccountCode, input.date, cur, r, input.amount,
      input.reference ?? null, entry.id]);
  for (const a of input.allocations) {
    await tx.query(
      "INSERT INTO payment_allocations (id, tenant_id, payment_id, document_type, document_id, amount) VALUES ($1,$2,$3,$4,$5,$6)",
      [newId(), ctx.tenantId, id, input.direction === "receipt" ? "sales_invoice" : "supplier_bill", a.documentId, a.amount]);
  }
  await audit(tx, ctx, `${input.direction}.posted`, "payment", id, { number, amount: input.amount, currency: cur });
  return { id, number };
}

export async function registerSales(app: FastifyInstance) {
  app.get("/api/sales-invoices", (req) => inTenant(req, (tx) => tx.query(
    `SELECT i.*, c.name AS customer_name, i.total - i.amount_paid AS outstanding,
            CASE WHEN i.kind = 'invoice' AND i.amount_paid < i.total AND i.due_date < current_date THEN true ELSE false END AS overdue
       FROM sales_invoices i JOIN contacts c ON c.id = i.customer_id ORDER BY i.date DESC, i.number DESC`)));

  app.get("/api/sales-invoices/:id", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const [inv] = await tx.query(
      `SELECT i.*, c.name AS customer_name, c.address AS customer_address, c.vat_number AS customer_vat_number,
              e.number AS journal_number, i.total - i.amount_paid AS outstanding, t.name AS company_name,
              t.vat_number AS company_vat_number, t.company_number, t.address AS company_address
         FROM sales_invoices i JOIN contacts c ON c.id = i.customer_id JOIN journal_entries e ON e.id = i.entry_id
         CROSS JOIN tenants t WHERE i.id = $1`, [id]);
    if (!inv) throw notFound("Invoice");
    const lines = await tx.query(
      `SELECT l.*, p.sku FROM sales_invoice_lines l LEFT JOIN products p ON p.id = l.product_id WHERE invoice_id = $1 ORDER BY line_no`, [id]);
    const payments = await tx.query(
      `SELECT p.number, p.date, a.amount FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
        WHERE a.document_id = $1 ORDER BY p.date`, [id]);
    return { ...inv, lines, payments };
  }));

  app.post("/api/sales-invoices", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const input = InvoiceInput.parse(req.body);
    return reply.status(201).send(await createSalesDocument(tx, ctx, "invoice", input));
  }));

  app.post("/api/credit-notes", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const input = InvoiceInput.parse(req.body);
    return reply.status(201).send(await createSalesDocument(tx, ctx, "credit", input));
  }));

  /** Apply a credit note against an invoice for the same customer. No ledger effect: both sit in debtors. */
  app.post("/api/credit-notes/:id/apply", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const { id } = IdParams.parse(req.params);
    const { invoiceId, amount } = z.object({ invoiceId: uuid, amount: positiveMoney }).parse(req.body);
    const docs = await tx.query<{ id: string; kind: string; customer_id: string; currency: string; rate: string; total: string; amount_paid: string }>(
      "SELECT id, kind, customer_id, currency, rate, total, amount_paid FROM sales_invoices WHERE id = ANY($1) FOR UPDATE", [[id, invoiceId]]);
    const cn = docs.find((x) => x.id === id && x.kind === "credit");
    const inv = docs.find((x) => x.id === invoiceId && x.kind === "invoice");
    if (!cn || !inv) throw notFound("Credit note or invoice");
    if (cn.customer_id !== inv.customer_id || cn.currency !== inv.currency || cn.rate !== inv.rate) {
      throw unprocessable("A credit note can only be applied to an invoice for the same customer, currency and rate");
    }
    for (const doc of [cn, inv]) {
      if (d(amount).greaterThan(d(doc.total).minus(doc.amount_paid))) throw unprocessable("Amount is more than is outstanding");
      await tx.query("UPDATE sales_invoices SET amount_paid = amount_paid + $2 WHERE id = $1", [doc.id, amount]);
    }
    await audit(tx, ctx, "credit_note.applied", "sales_invoice", id, { invoiceId, amount });
    return { ok: true };
  }));

  // ---------------------------------------------------------------- payments
  app.get("/api/payments", (req) => inTenant(req, (tx) => tx.query(
    `SELECT p.*, c.name AS contact_name,
            p.amount - coalesce((SELECT sum(amount) FROM payment_allocations a WHERE a.payment_id = p.id), 0) AS unallocated,
            EXISTS (SELECT 1 FROM bank_transactions b WHERE b.payment_id = p.id) AS reconciled
       FROM payments p JOIN contacts c ON c.id = p.contact_id ORDER BY p.date DESC, p.number DESC`)));

  app.post("/api/payments", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    return reply.status(201).send(await createPayment(tx, ctx, PaymentInput.parse(req.body)));
  }));
}
