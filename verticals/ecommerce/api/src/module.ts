import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inTenant, requireWrite, type Ctx } from "@softilo/api/lib/context";
import { notFound, unprocessable } from "@softilo/api/lib/errors";
import { assertAccount, audit, loadRoles, nextNumber, postJournal } from "@softilo/api/lib/ledger";
import { accountCode, addDays, IdParams, isoDate, money, uuid } from "@softilo/api/lib/schemas";
import { position, stockIn, stockOut } from "@softilo/api/lib/stock";
import { migrate, newId, type Database, type Sql } from "@softilo/db";
import { d, round6, toFixed, type Dec, type RoleMap } from "@softilo/domain";
import {
  adapterFor, amountsByOrder, CHANNEL_KINDS, ChannelFormatError, checkLineVat, ECOM_ACCOUNTS, ECOM_CHART, FEE_VAT_CODES,
  orderToSaleLines, PayoutMismatchError, planReturn, postChannelSale, postPayoutClearing, postReturn, refundDueBy,
  ReturnError, splitPayout, VatMismatchError, type ChannelKind, type ChannelOrder, type ChannelPayout, type FeeVatCode,
  type ReturnableLine, type VatTreatment,
} from "@softilo-ecommerce/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

export const ECOM_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Core migrations first, then this edition's (ecom_*.sql). */
export async function migrateEcommerce(db: Database): Promise<string[]> {
  return [...await migrate(db), ...await migrate(db, ECOM_MIGRATIONS_DIR)];
}

/** Default VAT on each channel's fees. Confirm per customer: see docs/plan.md. */
const DEFAULT_FEE_VAT: Record<ChannelKind, FeeVatCode> = {
  shopify: "RC20", // Shopify International Ltd (Ireland) bills UK VAT-registered merchants under the reverse charge.
  amazon: "S20",
  ebay: "S20",
  tiktok: "S20",
  woocommerce: "EX",
};

/** Only paid orders become invoices; refunds come through returns. */
const IMPORTABLE_STATUSES = new Set(["paid", "partially_refunded", "refunded"]);

const ChannelInput = z.object({
  kind: z.enum(CHANNEL_KINDS as [ChannelKind, ...ChannelKind[]]),
  name: z.string().trim().min(2).max(80),
  bankAccountCode: accountCode.default("1200"),
  warehouseId: uuid.optional(),
  feeVatCode: z.enum(FEE_VAT_CODES as [FeeVatCode, ...FeeVatCode[]]).optional(),
  vatTreatment: z.enum(["seller", "marketplace", "export"]).default("seller"),
});

const ReturnInput = z.object({
  receivedDate: isoDate,
  reason: z.string().max(200).optional(),
  lines: z.array(z.object({
    invoiceLineId: uuid,
    quantity: z.union([z.string(), z.number()]).transform(String)
      .refine((v) => /^\d{1,14}(\.\d{1,4})?$/.test(v) && Number(v) > 0, "Must be a positive quantity"),
    disposition: z.enum(["restock", "write_off"]),
  })).min(1).max(200),
  refundDelivery: z.boolean().default(false),
  deduction: money.optional(),
});

/** Domain rule failures are the user's to fix: answer 422 with the rule's message. */
async function rules<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ChannelFormatError || e instanceof VatMismatchError || e instanceof ReturnError || e instanceof PayoutMismatchError) {
      throw unprocessable(e.message);
    }
    throw e;
  }
}

async function ensureAccounts(tx: Sql, ctx: Ctx) {
  for (const a of ECOM_CHART) {
    await tx.query(
      "INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, code) DO NOTHING",
      [ctx.tenantId, a.code, a.name, a.type]);
  }
}

/** Gap-free numbering for this edition's documents (same scheme as the core). */
async function nextEcomNumber(tx: Sql, ctx: Ctx, kind: "ecom_return" | "ecom_payout"): Promise<string> {
  const prefix = kind === "ecom_return" ? "RMA" : "PAYOUT";
  const [row] = await tx.query<{ value: string }>(
    `INSERT INTO number_sequences (tenant_id, kind, prefix, next_value) VALUES ($1, $2, $3, 2)
     ON CONFLICT (tenant_id, kind) DO UPDATE SET next_value = number_sequences.next_value + 1
     RETURNING next_value - 1 AS value`,
    [ctx.tenantId, kind, prefix]);
  return `${prefix}-${String(row!.value).padStart(5, "0")}`;
}

type ChannelRow = {
  id: string; kind: ChannelKind; name: string; contact_id: string; warehouse_id: string;
  bank_account_code: string; fee_vat_code: FeeVatCode; vat_treatment: VatTreatment;
};

async function channel(tx: Sql, id: string): Promise<ChannelRow> {
  const [c] = await tx.query<ChannelRow>("SELECT * FROM ecom_channels WHERE id = $1", [id]);
  if (!c) throw notFound("Channel");
  return c;
}

type ProductRow = { id: string; sku: string; name: string; track_stock: boolean };

/** Why an order can't be imported, or undefined if it can. Checked before anything is written. */
async function orderProblem(tx: Sql, ch: ChannelRow, o: ChannelOrder, products: Map<string, ProductRow | undefined>): Promise<string | undefined> {
  if (!IMPORTABLE_STATUSES.has(o.financialStatus)) return `Payment is ${o.financialStatus.replace(/_/g, " ")}`;
  if (o.currency !== "GBP") return `${o.currency} orders are not supported yet`;
  let lines;
  try {
    lines = orderToSaleLines(o);
    for (const l of lines) checkLineVat(l.net, l.vat, l.vatCode);
  } catch (e) {
    if (e instanceof ChannelFormatError || e instanceof VatMismatchError) return e.message;
    throw e;
  }
  const needed = new Map<string, Dec>();
  for (const l of lines.filter((x) => x.kind === "goods")) {
    if (!l.sku) return `"${l.description}" has no SKU`;
    if (!products.has(l.sku)) {
      const [p] = await tx.query<ProductRow>("SELECT id, sku, name, track_stock FROM products WHERE sku = $1 AND NOT archived", [l.sku]);
      products.set(l.sku, p);
    }
    const p = products.get(l.sku);
    if (!p) return `SKU ${l.sku} is not set up as a product`;
    if (p.track_stock) needed.set(p.id, (needed.get(p.id) ?? d(0)).plus(l.quantity));
  }
  for (const [productId, qty] of needed) {
    const pos = await position(tx, productId, ch.warehouse_id);
    if (pos.quantity.lessThan(qty)) {
      const sku = [...products.values()].find((p) => p?.id === productId)!.sku;
      return `Not enough ${sku} in stock (${pos.quantity.toString()} on hand, ${qty.toString()} needed)`;
    }
  }
  return undefined;
}

/** A channel order becomes a sales invoice to the channel's customer account, issuing stock at average cost. */
async function importOrder(tx: Sql, ctx: Ctx, roles: RoleMap, ch: ChannelRow, o: ChannelOrder, products: Map<string, ProductRow | undefined>) {
  const lines = orderToSaleLines(o);
  const id = newId();
  const entryId = newId();
  const number = await nextNumber(tx, ctx, "sales_invoice");
  const src = { date: o.date, sourceType: "sales_invoice", sourceId: id, entryId };
  const posted = [];
  const stored: unknown[][] = [];
  let n = 1;
  for (const l of lines) {
    const product = l.sku ? products.get(l.sku) : undefined;
    const account = l.kind === "shipping" ? "4900" : roles.sales;
    const cost = product?.track_stock ? await stockOut(tx, ctx, product.id, ch.warehouse_id, l.quantity, src) : undefined;
    posted.push({ net: l.net, vat: l.vat, vatCode: l.vatCode, account, costGbp: cost, description: l.description });
    stored.push([newId(), ctx.tenantId, id, n++, product?.id ?? null, l.description, toFixed(l.quantity, 4),
      round6(l.net.dividedBy(l.quantity)).toFixed(6), toFixed(l.net), l.vatCode, toFixed(l.vat), account, toFixed(cost ?? 0)]);
  }
  const posting = postChannelSale(roles, { date: o.date, reference: `${number} ${ch.name} ${o.orderNumber}`, lines: posted });
  await postJournal(tx, ctx, posting, { type: "sales_invoice", id, entryId });
  await tx.query(
    `INSERT INTO sales_invoices (id, tenant_id, number, kind, customer_id, warehouse_id, customer_ref, date, due_date, currency, rate,
       total, total_gbp, entry_id)
     VALUES ($1,$2,$3,'invoice',$4,$5,$6,$7,$8,'GBP',1,$9,$9,$10)`,
    [id, ctx.tenantId, number, ch.contact_id, ch.warehouse_id, o.orderNumber, o.date, addDays(o.date, 7), toFixed(posting.total), entryId]);
  for (const row of stored) {
    await tx.query(
      `INSERT INTO sales_invoice_lines (id, tenant_id, invoice_id, line_no, product_id, description, quantity, unit_price, net,
         vat_code, vat, account_code, cost_gbp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, row);
  }
  const orderId = newId();
  await tx.query(
    `INSERT INTO ecom_orders (id, tenant_id, channel_id, external_id, order_number, date, currency, customer_name, customer_email,
       ship_country, vat_treatment, total, invoice_id, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [orderId, ctx.tenantId, ch.id, o.externalId, o.orderNumber, o.date, o.currency, o.customer.name, o.customer.email ?? null,
      o.shipCountry ?? null, o.vatTreatment, toFixed(posting.total), id, JSON.stringify(o)]);
  await audit(tx, ctx, "ecom_order.imported", "ecom_order", orderId, { channel: ch.name, order: o.orderNumber, invoice: number });
  return { id: orderId, orderNumber: o.orderNumber, invoiceNumber: number, total: toFixed(posting.total) };
}

interface PayoutMatch {
  kind: "order" | "refund";
  orderRef: string;
  orderId?: string;
  orderNumber?: string;
  amount: string;
  /** Invoice or credit notes this line settles, with the amount applied to each. */
  documents: { id: string; amount: Dec }[];
  problem?: string;
}

/** Match a payout's order and refund lines to the invoices and credit notes they settle. */
async function matchPayout(tx: Sql, ch: ChannelRow, p: ChannelPayout) {
  const problems: string[] = [];
  if (p.currency !== "GBP") problems.push(`${p.currency} payouts are not supported yet`);
  const [dup] = await tx.query<{ number: string }>("SELECT number FROM ecom_payouts WHERE channel_id = $1 AND external_id = $2", [ch.id, p.externalId]);
  if (dup) problems.push(`Payout ${p.externalId} has already been imported as ${dup.number}`);
  const matches: PayoutMatch[] = [];
  for (const kind of ["order", "refund"] as const) {
    for (const [ref, amount] of amountsByOrder(p, kind)) {
      const [o] = await tx.query<{ id: string; order_number: string; invoice_id: string }>(
        "SELECT id, order_number, invoice_id FROM ecom_orders WHERE channel_id = $1 AND external_id = $2", [ch.id, ref]);
      const m: PayoutMatch = { kind, orderRef: ref, orderId: o?.id, orderNumber: o?.order_number, amount: amount.toFixed(2), documents: [] };
      if (!o) {
        m.problem = `Order ${ref} has not been imported`;
      } else if (kind === "order") {
        const [inv] = await tx.query<{ outstanding: string }>("SELECT total - amount_paid AS outstanding FROM sales_invoices WHERE id = $1", [o.invoice_id]);
        if (!d(inv!.outstanding).equals(amount)) m.problem = `${o.order_number}: payout has ${amount.toFixed(2)} but ${d(inv!.outstanding).toFixed(2)} is outstanding`;
        else m.documents.push({ id: o.invoice_id, amount });
      } else {
        const credits = await tx.query<{ id: string; outstanding: string }>(
          `SELECT id, total - amount_paid AS outstanding FROM sales_invoices
            WHERE credits_id = $1 AND kind = 'credit' AND amount_paid < total ORDER BY date, number`, [o.invoice_id]);
        let left = amount;
        for (const c of credits) {
          if (left.isZero()) break;
          const outstanding = d(c.outstanding);
          const take = left.lessThan(outstanding) ? left : outstanding;
          m.documents.push({ id: c.id, amount: take });
          left = left.minus(take);
        }
        if (!left.isZero()) m.problem = `${o.order_number}: refund of ${amount.toFixed(2)} has no matching return (record the return first)`;
      }
      if (m.problem) problems.push(m.problem);
      matches.push(m);
    }
  }
  const split = splitPayout(p, ch.fee_vat_code);
  if (!split.reconciled) problems.push(`Payout lines add up to ${split.computed.toFixed(2)} but ${split.amount.toFixed(2)} was paid`);
  return { split, matches, problems };
}

function splitJson(s: ReturnType<typeof splitPayout>) {
  return {
    sales: s.sales.toFixed(2), refunds: s.refunds.toFixed(2), feesGross: s.feesGross.toFixed(2), feesNet: s.feesNet.toFixed(2),
    feesVat: s.feesVat.toFixed(2), feeVatCode: s.feeVatCode, reserves: s.reserves.toFixed(2), adjustments: s.adjustments.toFixed(2),
    computed: s.computed.toFixed(2), amount: s.amount.toFixed(2), difference: s.difference.toFixed(2), reconciled: s.reconciled,
  };
}

export async function registerEcommerce(app: FastifyInstance) {
  // ---------------------------------------------------------------- channels
  app.get("/api/ecommerce/channels", (req) => inTenant(req, (tx) => tx.query(
    `SELECT c.*, w.code AS warehouse_code,
            (SELECT count(*) FROM ecom_orders o WHERE o.channel_id = c.id) AS orders,
            (SELECT coalesce(sum(i.total - i.amount_paid), 0) FROM ecom_orders o JOIN sales_invoices i ON i.id = o.invoice_id
              WHERE o.channel_id = c.id) AS awaiting_payout,
            (SELECT max(date) FROM ecom_payouts p WHERE p.channel_id = c.id) AS last_payout
       FROM ecom_channels c JOIN warehouses w ON w.id = c.warehouse_id ORDER BY c.name`)));

  app.post("/api/ecommerce/channels", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "settings");
    const input = ChannelInput.parse(req.body);
    await ensureAccounts(tx, ctx);
    await assertAccount(tx, input.bankAccountCode, { bank: true });
    const [w] = input.warehouseId
      ? await tx.query<{ id: string }>("SELECT id FROM warehouses WHERE id = $1", [input.warehouseId])
      : await tx.query<{ id: string }>("SELECT id FROM warehouses ORDER BY code = 'MAIN' DESC, code LIMIT 1");
    if (!w) throw unprocessable("Warehouse not found");
    const [taken] = await tx.query("SELECT 1 FROM ecom_channels WHERE name = $1", [input.name]);
    if (taken) throw unprocessable(`A channel called ${input.name} already exists`);
    const contactId = newId();
    await tx.query(
      "INSERT INTO contacts (id, tenant_id, kind, name, payment_terms_days) VALUES ($1,$2,'customer',$3,7)",
      [contactId, ctx.tenantId, `${input.name} (sales channel)`]);
    const id = newId();
    await tx.query(
      `INSERT INTO ecom_channels (id, tenant_id, kind, name, contact_id, warehouse_id, bank_account_code, fee_vat_code, vat_treatment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, ctx.tenantId, input.kind, input.name, contactId, w.id, input.bankAccountCode,
        input.feeVatCode ?? DEFAULT_FEE_VAT[input.kind], input.vatTreatment]);
    await audit(tx, ctx, "ecom_channel.created", "ecom_channel", id, input);
    return reply.status(201).send({ id });
  }));

  // ---------------------------------------------------------------- orders
  app.post("/api/ecommerce/channels/:id/orders/import", (req) => inTenant(req, (tx, ctx) => rules(async () => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const { payload } = z.object({ payload: z.unknown() }).parse(req.body);
    const ch = await channel(tx, id);
    const orders = adapterFor(ch.kind, { vatTreatment: ch.vat_treatment }).parseOrders(payload);
    await ensureAccounts(tx, ctx);
    const roles = await loadRoles(tx);
    const products = new Map<string, ProductRow | undefined>();
    const imported = [];
    const skipped: { orderNumber: string; reason: string }[] = [];
    for (const o of orders) {
      const [existing] = await tx.query("SELECT 1 FROM ecom_orders WHERE channel_id = $1 AND external_id = $2", [ch.id, o.externalId]);
      if (existing) {
        skipped.push({ orderNumber: o.orderNumber, reason: "Already imported" });
        continue;
      }
      const problem = await orderProblem(tx, ch, o, products);
      if (problem) {
        skipped.push({ orderNumber: o.orderNumber, reason: problem });
        continue;
      }
      imported.push(await importOrder(tx, ctx, roles, ch, o, products));
    }
    return { imported, skipped };
  })));

  app.get("/api/ecommerce/orders", (req) => inTenant(req, async (tx) => {
    const q = z.object({ channelId: uuid.optional() }).parse(req.query);
    return tx.query(
      `SELECT o.id, o.order_number, o.date, o.customer_name, o.ship_country, o.vat_treatment, o.total, o.currency,
              c.name AS channel_name, c.kind AS channel_kind, i.id AS invoice_id, i.number AS invoice_number, i.amount_paid,
              (SELECT coalesce(sum(net), 0) FROM sales_invoice_lines l WHERE l.invoice_id = i.id) AS net,
              (SELECT coalesce(sum(cost_gbp), 0) FROM sales_invoice_lines l WHERE l.invoice_id = i.id) AS cost,
              (SELECT coalesce(sum(refund), 0) FROM ecom_returns r WHERE r.order_id = o.id) AS refunded
         FROM ecom_orders o JOIN ecom_channels c ON c.id = o.channel_id JOIN sales_invoices i ON i.id = o.invoice_id
        WHERE ($1::uuid IS NULL OR o.channel_id = $1) ORDER BY o.date DESC, o.order_number DESC`, [q.channelId ?? null]);
  }));

  app.get("/api/ecommerce/orders/:id", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const [o] = await tx.query<{ invoice_id: string }>(
      `SELECT o.id, o.external_id, o.order_number, o.date, o.customer_name, o.customer_email, o.ship_country, o.vat_treatment,
              o.total, o.currency, o.invoice_id, c.name AS channel_name, c.kind AS channel_kind, i.number AS invoice_number,
              i.amount_paid, i.total AS invoice_total
         FROM ecom_orders o JOIN ecom_channels c ON c.id = o.channel_id JOIN sales_invoices i ON i.id = o.invoice_id WHERE o.id = $1`, [id]);
    if (!o) throw notFound("Order");
    const lines = await tx.query(
      `SELECT l.id, l.line_no, l.description, l.quantity, l.unit_price, l.net, l.vat, l.vat_code, l.cost_gbp, l.product_id, p.sku,
              coalesce((SELECT sum(r.quantity) FROM ecom_return_lines r WHERE r.invoice_line_id = l.id), 0) AS returned_qty
         FROM sales_invoice_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.invoice_id = $1 ORDER BY l.line_no`, [o.invoice_id]);
    const returns = await tx.query(
      `SELECT r.id, r.number, r.received_date, r.refund_due_by, r.refund, r.deduction, r.reason, cn.number AS credit_note_number,
              cn.amount_paid >= cn.total AS refunded
         FROM ecom_returns r JOIN sales_invoices cn ON cn.id = r.credit_note_id WHERE r.order_id = $1 ORDER BY r.created_at`, [id]);
    const payouts = await tx.query(
      `SELECT DISTINCT p.id, p.number, p.date, p.external_id FROM ecom_payout_lines l JOIN ecom_payouts p ON p.id = l.payout_id
        WHERE l.order_id = $1 ORDER BY p.date`, [id]);
    return { ...o, lines, returns, payouts };
  }));

  // ---------------------------------------------------------------- returns
  app.post("/api/ecommerce/orders/:id/returns", (req, reply) => inTenant(req, (tx, ctx) => rules(async () => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const input = ReturnInput.parse(req.body);
    const [o] = await tx.query<{ id: string; order_number: string; invoice_id: string; customer_id: string; warehouse_id: string; date: string }>(
      `SELECT o.id, o.order_number, o.invoice_id, i.customer_id, i.warehouse_id, o.date
         FROM ecom_orders o JOIN sales_invoices i ON i.id = o.invoice_id WHERE o.id = $1`, [id]);
    if (!o) throw notFound("Order");
    if (input.receivedDate < o.date) throw unprocessable("The return can't be received before the order date");
    type LineRow = {
      id: string; description: string; quantity: string; net: string; vat: string; vat_code: string; account_code: string;
      cost_gbp: string; product_id: string | null; track_stock: boolean | null; r_qty: string; r_net: string; r_vat: string; r_cost: string;
    };
    const rows = await tx.query<LineRow>(
      `SELECT l.id, l.description, l.quantity, l.net, l.vat, l.vat_code, l.account_code, l.cost_gbp, l.product_id, p.track_stock,
              coalesce(sum(r.quantity), 0) AS r_qty, coalesce(sum(r.net), 0) AS r_net, coalesce(sum(r.vat), 0) AS r_vat,
              coalesce(sum(r.cost_gbp), 0) AS r_cost
         FROM sales_invoice_lines l LEFT JOIN products p ON p.id = l.product_id LEFT JOIN ecom_return_lines r ON r.invoice_line_id = l.id
        WHERE l.invoice_id = $1 GROUP BY l.id, p.track_stock ORDER BY l.line_no`, [o.invoice_id]);
    const returnable = (r: LineRow): ReturnableLine => ({
      id: r.id, description: r.description, quantity: r.quantity, net: r.net, vat: r.vat, vatCode: r.vat_code as ReturnableLine["vatCode"],
      account: r.account_code, costGbp: r.cost_gbp, returned: { quantity: r.r_qty, net: r.r_net, vat: r.r_vat, cost: r.r_cost },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const requested = input.lines.map((l) => {
      const row = byId.get(l.invoiceLineId);
      if (!row || !row.product_id) throw unprocessable("Each returned item must be a product line on this order");
      return { line: returnable(row), quantity: l.quantity, disposition: l.disposition, row };
    });
    const delivery = input.refundDelivery ? rows.filter((r) => !r.product_id).map(returnable) : [];
    const plan = planReturn({ lines: requested, shipping: delivery, deductionGross: input.deduction });

    await ensureAccounts(tx, ctx);
    const roles = await loadRoles(tx);
    const number = await nextEcomNumber(tx, ctx, "ecom_return");
    const cnId = newId();
    const entryId = newId();
    const cnNumber = await nextNumber(tx, ctx, "credit_note");
    const src = { date: input.receivedDate, sourceType: "sales_invoice", sourceId: cnId, entryId };
    for (const [i, l] of plan.lines.entries()) {
      const row = requested[i]!.row;
      if (l.disposition === "restock" && row.track_stock) {
        await stockIn(tx, ctx, row.product_id!, o.warehouse_id, l.quantity, l.cost, "return", src);
      }
    }
    const posting = postReturn(roles, ECOM_ACCOUNTS, { date: input.receivedDate, reference: `${number} ${cnNumber} ${o.order_number}`, plan });
    await postJournal(tx, ctx, posting, { type: "sales_invoice", id: cnId, entryId });
    await tx.query(
      `INSERT INTO sales_invoices (id, tenant_id, number, kind, customer_id, warehouse_id, customer_ref, date, due_date, currency, rate,
         total, total_gbp, credits_id, entry_id)
       VALUES ($1,$2,$3,'credit',$4,$5,$6,$7,$7,'GBP',1,$8,$8,$9,$10)`,
      [cnId, ctx.tenantId, cnNumber, o.customer_id, o.warehouse_id, `${o.order_number} ${number}`, input.receivedDate,
        toFixed(plan.refund), o.invoice_id, entryId]);
    const cnLines = [
      ...plan.lines.map((l, i) => ({ productId: requested[i]!.row.product_id, description: l.description, quantity: l.quantity, net: l.net, vat: l.vat, code: l.vatCode, account: l.account, cost: l.disposition === "restock" ? l.cost : d(0) })),
      ...plan.shipping.map((s) => ({ productId: null, description: s.description, quantity: d(1), net: s.net, vat: s.vat, code: s.vatCode, account: s.account, cost: d(0) })),
      ...(plan.deduction ? [{ productId: null, description: plan.deduction.description, quantity: d(1), net: plan.deduction.net.neg(), vat: plan.deduction.vat.neg(), code: plan.deduction.vatCode, account: plan.deduction.account, cost: d(0) }] : []),
    ];
    let n = 1;
    for (const l of cnLines) {
      await tx.query(
        `INSERT INTO sales_invoice_lines (id, tenant_id, invoice_id, line_no, product_id, description, quantity, unit_price, net,
           vat_code, vat, account_code, cost_gbp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [newId(), ctx.tenantId, cnId, n++, l.productId, l.description, toFixed(l.quantity, 4), round6(l.net.dividedBy(l.quantity)).toFixed(6),
          toFixed(l.net), l.code, toFixed(l.vat), l.account, toFixed(l.cost)]);
    }
    const returnId = newId();
    await tx.query(
      `INSERT INTO ecom_returns (id, tenant_id, number, order_id, credit_note_id, received_date, refund_due_by, reason, refund, deduction,
         shipping_refunded, entry_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [returnId, ctx.tenantId, number, o.id, cnId, input.receivedDate, refundDueBy(input.receivedDate), input.reason ?? null,
        toFixed(plan.refund), toFixed(input.deduction ?? 0), delivery.length > 0, entryId]);
    const retLines = [
      ...plan.lines.map((l) => [l.invoiceLineId, l.quantity, l.net, l.vat, l.cost, l.disposition] as const),
      ...plan.shipping.map((s) => [s.invoiceLineId!, d(1), s.net, s.vat, d(0), "delivery"] as const),
    ];
    for (const [lineId, q, net, vat, cost, disp] of retLines) {
      await tx.query(
        `INSERT INTO ecom_return_lines (id, tenant_id, return_id, invoice_line_id, quantity, net, vat, cost_gbp, disposition)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [newId(), ctx.tenantId, returnId, lineId, toFixed(q, 4), toFixed(net), toFixed(vat), toFixed(cost), disp]);
    }
    await audit(tx, ctx, "ecom_return.recorded", "ecom_return", returnId, { number, order: o.order_number, refund: toFixed(plan.refund), creditNote: cnNumber });
    return reply.status(201).send({ id: returnId, number, creditNoteNumber: cnNumber, refund: toFixed(plan.refund), refundDueBy: refundDueBy(input.receivedDate) });
  })));

  app.get("/api/ecommerce/returns", (req) => inTenant(req, (tx) => tx.query(
    `SELECT r.id, r.number, r.received_date, r.refund_due_by, r.refund, r.deduction, r.reason, r.shipping_refunded,
            o.id AS order_id, o.order_number, o.customer_name, c.name AS channel_name, cn.number AS credit_note_number,
            cn.amount_paid >= cn.total AS refunded,
            (cn.amount_paid < cn.total AND r.refund_due_by < current_date) AS overdue,
            (SELECT coalesce(sum(quantity), 0) FROM ecom_return_lines l WHERE l.return_id = r.id AND l.disposition = 'restock') AS restocked,
            (SELECT coalesce(sum(quantity), 0) FROM ecom_return_lines l WHERE l.return_id = r.id AND l.disposition = 'write_off') AS written_off
       FROM ecom_returns r JOIN ecom_orders o ON o.id = r.order_id JOIN ecom_channels c ON c.id = o.channel_id
       JOIN sales_invoices cn ON cn.id = r.credit_note_id ORDER BY r.received_date DESC, r.number DESC`)));

  // ---------------------------------------------------------------- payouts
  const PayoutBody = z.object({ payload: z.unknown(), bankAccountCode: accountCode.optional() });

  app.post("/api/ecommerce/channels/:id/payouts/preview", (req) => inTenant(req, (tx) => rules(async () => {
    const { id } = IdParams.parse(req.params);
    const { payload } = PayoutBody.parse(req.body);
    const ch = await channel(tx, id);
    const p = adapterFor(ch.kind).parsePayout(payload);
    const { split, matches, problems } = await matchPayout(tx, ch, p);
    return {
      externalId: p.externalId, date: p.date, currency: p.currency, split: splitJson(split), problems,
      matches: matches.map(({ documents, ...m }) => m),
    };
  })));

  app.post("/api/ecommerce/channels/:id/payouts", (req, reply) => inTenant(req, (tx, ctx) => rules(async () => {
    requireWrite(ctx, "finance");
    const { id } = IdParams.parse(req.params);
    const body = PayoutBody.parse(req.body);
    const ch = await channel(tx, id);
    const p = adapterFor(ch.kind).parsePayout(body.payload);
    const { split, matches, problems } = await matchPayout(tx, ch, p);
    if (problems.length) throw unprocessable(problems.join("; "));
    const bank = body.bankAccountCode ?? ch.bank_account_code;
    await assertAccount(tx, bank, { bank: true });
    await ensureAccounts(tx, ctx);
    for (const m of matches) {
      for (const doc of m.documents) {
        await tx.query("UPDATE sales_invoices SET amount_paid = amount_paid + $2 WHERE id = $1", [doc.id, toFixed(doc.amount)]);
      }
    }
    const payoutId = newId();
    const number = await nextEcomNumber(tx, ctx, "ecom_payout");
    const posting = postPayoutClearing(await loadRoles(tx), {
      date: p.date, reference: `${number} ${ch.name} ${p.externalId}`, bankAccount: bank, split, accounts: ECOM_ACCOUNTS,
    });
    const entry = await postJournal(tx, ctx, posting, { type: "ecom_payout", id: payoutId });
    await tx.query(
      `INSERT INTO ecom_payouts (id, tenant_id, number, channel_id, external_id, date, currency, amount, sales, refunds, fees_net, fees_vat,
         fee_vat_code, reserves, adjustments, bank_account_code, entry_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [payoutId, ctx.tenantId, number, ch.id, p.externalId, p.date, p.currency, toFixed(split.amount), toFixed(split.sales),
        toFixed(split.refunds), toFixed(split.feesNet), toFixed(split.feesVat), split.feeVatCode, toFixed(split.reserves),
        toFixed(split.adjustments), bank, entry.id]);
    const orderIds = new Map(matches.map((m) => [m.orderRef, m.orderId]));
    let n = 1;
    for (const l of p.lines) {
      await tx.query(
        `INSERT INTO ecom_payout_lines (id, tenant_id, payout_id, line_no, kind, order_ref, order_id, amount, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [newId(), ctx.tenantId, payoutId, n++, l.kind, l.orderRef ?? null, l.orderRef ? orderIds.get(l.orderRef) ?? null : null, l.amount, l.description]);
    }
    await audit(tx, ctx, "ecom_payout.posted", "ecom_payout", payoutId, { number, channel: ch.name, externalId: p.externalId, amount: toFixed(split.amount) });
    return reply.status(201).send({ id: payoutId, number, journalNumber: entry.number, split: splitJson(split) });
  })));

  app.get("/api/ecommerce/payouts", (req) => inTenant(req, (tx) => tx.query(
    `SELECT p.*, c.name AS channel_name, c.kind AS channel_kind, e.number AS journal_number,
            p.fees_net + CASE WHEN p.fee_vat_code = 'RC20' THEN 0 ELSE p.fees_vat END AS fees_gross
       FROM ecom_payouts p JOIN ecom_channels c ON c.id = p.channel_id JOIN journal_entries e ON e.id = p.entry_id
      ORDER BY p.date DESC, p.number DESC`)));

  app.get("/api/ecommerce/payouts/:id", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const [p] = await tx.query<{ entry_id: string }>(
      `SELECT p.*, c.name AS channel_name, c.kind AS channel_kind, e.number AS journal_number
         FROM ecom_payouts p JOIN ecom_channels c ON c.id = p.channel_id JOIN journal_entries e ON e.id = p.entry_id WHERE p.id = $1`, [id]);
    if (!p) throw notFound("Payout");
    const lines = await tx.query(
      `SELECT l.line_no, l.kind, l.order_ref, l.amount, l.description, o.id AS order_id, o.order_number
         FROM ecom_payout_lines l LEFT JOIN ecom_orders o ON o.id = l.order_id WHERE l.payout_id = $1 ORDER BY l.line_no`, [id]);
    const journal = await tx.query(
      `SELECT l.account_code, a.name AS account_name, l.debit, l.credit, l.description
         FROM journal_lines l JOIN accounts a ON a.code = l.account_code WHERE l.entry_id = $1 ORDER BY l.line_no`, [p.entry_id]);
    return { ...p, lines, journal };
  }));

  // Totals for the e-commerce overview.
  app.get("/api/ecommerce/summary", (req) => inTenant(req, async (tx) => {
    const [s] = await tx.query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM ecom_orders) AS orders,
              (SELECT coalesce(sum(i.total - i.amount_paid), 0) FROM ecom_orders o JOIN sales_invoices i ON i.id = o.invoice_id) AS awaiting_payout,
              (SELECT coalesce(sum(l.net), 0) FROM ecom_orders o JOIN sales_invoice_lines l ON l.invoice_id = o.invoice_id) AS net_sales,
              (SELECT coalesce(sum(l.cost_gbp), 0) FROM ecom_orders o JOIN sales_invoice_lines l ON l.invoice_id = o.invoice_id) AS cost,
              (SELECT coalesce(sum(fees_net), 0) FROM ecom_payouts) AS fees,
              (SELECT count(*) FROM ecom_returns r JOIN sales_invoices cn ON cn.id = r.credit_note_id
                WHERE cn.amount_paid < cn.total AND r.refund_due_by < current_date) AS overdue_refunds`);
    return { ...s, margin: d(s!.net_sales!).minus(s!.cost!).toFixed(2) };
  }));
}
