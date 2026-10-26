import { inTenant, requireWrite, type Ctx } from "@softilo/api/lib/context";
import { AppError, notFound, unprocessable } from "@softilo/api/lib/errors";
import { audit, loadRoles, postJournal } from "@softilo/api/lib/ledger";
import { IdParams, isoDate, quantity, rate, today, uuid } from "@softilo/api/lib/schemas";
import { stockOut } from "@softilo/api/lib/stock";
import { receiveGoods } from "@softilo/api/modules/purchasing";
import { createSalesDocument, InvoiceInput } from "@softilo/api/modules/sales";
import { newId, type Sql } from "@softilo/db";
import { d, postStockAdjustment, sum, toFixed, ZERO, type Dec } from "@softilo/domain";
import {
  allocateFefo, batchStatus, checkManualAllocation, daysBetween, expiryFrom, InsufficientBatchStockError, summariseTrace,
  unsellableReason, type BatchAllocation, type BatchStock,
} from "@softilo/fnb-domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { batchStock, findOrCreateBatch, moveBatch, qty, trackedSettings } from "./batches.js";

export const ALLERGENS = [
  "gluten", "crustaceans", "eggs", "fish", "peanuts", "soybeans", "milk", "nuts",
  "celery", "mustard", "sesame", "sulphites", "lupin", "molluscs",
] as const;

/** Account for disposals of expired or damaged food, created on first use. */
const WASTE_ACCOUNT = { code: "5050", name: "Stock waste and write-offs" };

const SettingsInput = z.object({
  batchTracked: z.boolean().default(true),
  dateType: z.enum(["use_by", "best_before"]).default("use_by"),
  shelfLifeDays: z.number().int().min(0).max(3650).nullable().optional(),
  storage: z.enum(["ambient", "chilled", "frozen"]).default("ambient"),
  allergens: z.array(z.enum(ALLERGENS)).max(14).default([]),
});

const ReceiveInput = z.object({
  date: isoDate,
  rate: rate.optional(),
  lines: z.array(z.object({
    poLineId: uuid,
    quantity,
    batchCode: z.string().trim().min(1).max(60).optional(),
    /** Use-by or best-before date. If left out, worked out from the product's shelf life. */
    expiry: isoDate.optional(),
  })).min(1).max(500),
});

const BatchPick = z.object({ batchId: uuid, quantity });
const FnbInvoiceInput = InvoiceInput.extend({
  lines: z.array(InvoiceInput.shape.lines.element.extend({
    /** Batches chosen by hand. Left out, stock is allocated first expiry, first out. */
    batches: z.array(BatchPick).min(1).max(50).optional(),
  })).min(1).max(500),
});

/** Same warehouse choice as the core invoice: the one given, else MAIN, else the first. */
async function invoiceWarehouse(tx: Sql, warehouseId?: string): Promise<string> {
  const [w] = warehouseId
    ? await tx.query<{ id: string }>("SELECT id FROM warehouses WHERE id = $1", [warehouseId])
    : await tx.query<{ id: string }>("SELECT id FROM warehouses ORDER BY code = 'MAIN' DESC, code LIMIT 1");
  if (!w) throw unprocessable("Warehouse not found");
  return w.id;
}

async function minLifeDays(tx: Sql, customerId: string): Promise<number> {
  const [s] = await tx.query<{ min_life_days: number }>("SELECT min_life_days FROM fnb_customer_settings WHERE contact_id = $1", [customerId]);
  return s?.min_life_days ?? 0;
}

function allocationError(e: unknown, label: string): never {
  if (e instanceof InsufficientBatchStockError || e instanceof Error) throw unprocessable(`${label}: ${e.message}`);
  throw e;
}

/** Allocate batches to each tracked line, taking earlier lines on the same invoice into account. */
async function allocateLines(
  tx: Sql, warehouseId: string, date: string, minLife: number,
  lines: { productId?: string; quantity: string; batches?: { batchId: string; quantity: string }[]; description?: string }[],
): Promise<(BatchAllocation[] | null)[]> {
  const settings = await trackedSettings(tx, lines.flatMap((l) => (l.productId ? [l.productId] : [])));
  const stock = new Map<string, BatchStock[]>();
  const used = new Map<string, Dec>();
  const result: (BatchAllocation[] | null)[] = [];
  for (const [i, l] of lines.entries()) {
    if (!l.productId || !settings.has(l.productId)) {
      if (l.batches) throw unprocessable(`Line ${i + 1}: this product is not batch-tracked`);
      result.push(null);
      continue;
    }
    if (!stock.has(l.productId)) stock.set(l.productId, await batchStock(tx, l.productId, warehouseId, true));
    const available = stock.get(l.productId)!.map((b) => ({ ...b, available: d(b.available).minus(used.get(b.id) ?? ZERO) }));
    const opts = { today: date, minLifeDays: minLife };
    let allocation: BatchAllocation[];
    try {
      allocation = l.batches ? checkManualAllocation(available, l.batches, l.quantity, opts) : allocateFefo(available, l.quantity, opts);
    } catch (e) {
      allocationError(e, `Line ${i + 1}${l.description ? ` (${l.description})` : ""}`);
    }
    for (const a of allocation) used.set(a.batchId, (used.get(a.batchId) ?? ZERO).plus(a.quantity));
    result.push(allocation);
  }
  return result;
}

async function invoiceLineIds(tx: Sql, invoiceId: string): Promise<string[]> {
  const rows = await tx.query<{ id: string }>("SELECT id FROM sales_invoice_lines WHERE invoice_id = $1 ORDER BY line_no", [invoiceId]);
  return rows.map((r) => r.id);
}

/**
 * Core routes still work for products that are not batch-tracked. For batch-tracked products they would move stock
 * without recording which batch, so they are refused and the batch-aware route is named instead.
 */
function guardCoreRoutes(app: FastifyInstance) {
  type Body = { lines?: { poLineId?: string; productId?: string; returnToStock?: boolean }[]; productId?: string };
  const guarded: Record<string, { route: string; products: (tx: Sql, body: Body) => Promise<string[]> }> = {
    "/api/purchase-orders/:id/receive": {
      route: "/api/fnb/purchase-orders/:id/receive",
      products: async (tx, body) => {
        const ids = (body.lines ?? []).map((l) => l.poLineId).filter((x): x is string => typeof x === "string" && UUID.test(x));
        if (!ids.length) return [];
        return (await tx.query<{ product_id: string }>("SELECT product_id FROM purchase_order_lines WHERE id = ANY($1::uuid[])", [ids]))
          .map((r) => r.product_id);
      },
    },
    "/api/sales-invoices": { route: "/api/fnb/sales-invoices", products: async (_tx, body) => (body.lines ?? []).map((l) => l.productId!).filter(Boolean) },
    "/api/credit-notes": {
      route: "/api/fnb/credit-notes",
      products: async (_tx, body) => (body.lines ?? []).filter((l) => l.returnToStock).map((l) => l.productId!).filter(Boolean),
    },
    "/api/stock/adjustments": { route: "/api/fnb/batches/:id/write-off", products: async (_tx, body) => (body.productId ? [body.productId] : []) },
  };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const guard = req.method === "POST" ? guarded[req.routeOptions.url ?? ""] : undefined;
    if (!guard || !req.ctx || !req.body || typeof req.body !== "object") return;
    const tracked = await req.server.db.tenant(req.ctx.tenantId, async (tx) => {
      const ids = (await guard.products(tx, req.body as Body)).filter((x) => typeof x === "string" && UUID.test(x));
      return trackedSettings(tx, ids);
    });
    if (tracked.size) {
      throw new AppError(422, `This includes batch-tracked food products. Use ${guard.route} so the batch and date are recorded.`, "batch_required");
    }
  });
}

export async function registerFoodBeverage(app: FastifyInstance) {
  guardCoreRoutes(app);

  // ---------------------------------------------------------------- product and customer settings
  app.get("/api/fnb/products", (req) => inTenant(req, (tx) => tx.query(
    `SELECT p.id, p.sku, p.name, p.uom, p.sales_price, coalesce(s.batch_tracked, false) AS batch_tracked, s.date_type,
            s.shelf_life_days, s.storage, coalesce(s.allergens, '{}') AS allergens,
            (SELECT coalesce(sum(quantity), 0) FROM stock_balances b WHERE b.product_id = p.id) AS on_hand
       FROM products p LEFT JOIN fnb_product_settings s ON s.product_id = p.id
      WHERE NOT p.archived ORDER BY p.sku`)));

  app.get("/api/fnb/products/:id/settings", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const [p] = await tx.query("SELECT id, sku, name FROM products WHERE id = $1", [id]);
    if (!p) throw notFound("Product");
    const [s] = await tx.query("SELECT * FROM fnb_product_settings WHERE product_id = $1", [id]);
    return { product: p, settings: s ?? null };
  }));

  app.put("/api/fnb/products/:id/settings", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const input = SettingsInput.parse(req.body);
    const [p] = await tx.query<{ track_stock: boolean }>("SELECT track_stock FROM products WHERE id = $1", [id]);
    if (!p) throw notFound("Product");
    if (input.batchTracked && !p.track_stock) throw unprocessable("Only stocked products can be batch-tracked");
    const [prev] = await tx.query<{ batch_tracked: boolean }>("SELECT batch_tracked FROM fnb_product_settings WHERE product_id = $1", [id]);
    if (input.batchTracked && !prev?.batch_tracked) {
      // Switching tracking on is only safe with no stock on hand, or the batches would not add up to the stock.
      const [s] = await tx.query<{ q: string }>("SELECT coalesce(sum(quantity), 0) AS q FROM stock_balances WHERE product_id = $1", [id]);
      if (!d(s!.q).isZero()) throw unprocessable("Batch tracking can only be switched on while the product has no stock on hand");
    }
    if (!input.batchTracked && prev?.batch_tracked) {
      const [s] = await tx.query<{ q: string }>(
        "SELECT coalesce(sum(bb.quantity), 0) AS q FROM fnb_batch_balances bb JOIN fnb_batches b ON b.id = bb.batch_id WHERE b.product_id = $1", [id]);
      if (!d(s!.q).isZero()) throw unprocessable("Batch tracking can only be switched off once no batches are left in stock");
    }
    await tx.query(
      `INSERT INTO fnb_product_settings (tenant_id, product_id, batch_tracked, date_type, shelf_life_days, storage, allergens, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (tenant_id, product_id) DO UPDATE SET batch_tracked = EXCLUDED.batch_tracked, date_type = EXCLUDED.date_type,
         shelf_life_days = EXCLUDED.shelf_life_days, storage = EXCLUDED.storage, allergens = EXCLUDED.allergens, updated_at = now()`,
      [ctx.tenantId, id, input.batchTracked, input.dateType, input.shelfLifeDays ?? null, input.storage, input.allergens]);
    await audit(tx, ctx, "fnb.product_settings.updated", "product", id, input);
    const [s] = await tx.query("SELECT * FROM fnb_product_settings WHERE product_id = $1", [id]);
    return s;
  }));

  app.get("/api/fnb/customers", (req) => inTenant(req, (tx) => tx.query(
    `SELECT c.id, c.name, coalesce(s.min_life_days, 0) AS min_life_days
       FROM contacts c LEFT JOIN fnb_customer_settings s ON s.contact_id = c.id
      WHERE c.kind IN ('customer','both') AND NOT c.archived ORDER BY c.name`)));

  app.put("/api/fnb/customers/:id/settings", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const input = z.object({ minLifeDays: z.number().int().min(0).max(3650) }).parse(req.body);
    const [c] = await tx.query<{ kind: string }>("SELECT kind FROM contacts WHERE id = $1", [id]);
    if (!c || c.kind === "supplier") throw notFound("Customer");
    await tx.query(
      `INSERT INTO fnb_customer_settings (tenant_id, contact_id, min_life_days) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, contact_id) DO UPDATE SET min_life_days = EXCLUDED.min_life_days, updated_at = now()`,
      [ctx.tenantId, id, input.minLifeDays]);
    await audit(tx, ctx, "fnb.customer_settings.updated", "contact", id, input);
    return { contactId: id, minLifeDays: input.minLifeDays };
  }));

  // ---------------------------------------------------------------- batch-aware receiving
  app.post("/api/fnb/purchase-orders/:id/receive", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const input = ReceiveInput.parse(req.body);
    const [po] = await tx.query<{ supplier_id: string; warehouse_id: string }>("SELECT supplier_id, warehouse_id FROM purchase_orders WHERE id = $1", [id]);
    if (!po) throw notFound("Purchase order");
    const poLines = await tx.query<{ id: string; product_id: string; description: string }>(
      "SELECT id, product_id, description FROM purchase_order_lines WHERE po_id = $1", [id]);
    const byLine = new Map(poLines.map((l) => [l.id, l]));
    const settings = await trackedSettings(tx, poLines.map((l) => l.product_id));

    // Check every batch before anything is posted.
    const planned = input.lines.map((l, i) => {
      const pl = byLine.get(l.poLineId);
      if (!pl) throw unprocessable(`Line ${i + 1}: purchase order line not found`);
      const s = settings.get(pl.product_id);
      if (!s) {
        if (l.batchCode || l.expiry) throw unprocessable(`Line ${i + 1}: "${pl.description}" is not batch-tracked`);
        return null;
      }
      if (!l.batchCode) throw unprocessable(`Line ${i + 1}: enter the batch code for "${pl.description}"`);
      const expiry = l.expiry ?? (s.shelf_life_days !== null ? expiryFrom(input.date, s.shelf_life_days) : null);
      if (!expiry && s.date_type === "use_by") throw unprocessable(`Line ${i + 1}: enter the use-by date for batch ${l.batchCode}`);
      if (expiry && s.date_type === "use_by" && daysBetween(input.date, expiry) < 0) {
        throw unprocessable(`Line ${i + 1}: batch ${l.batchCode} is already past its use-by date (${expiry}); reject the delivery`);
      }
      return { productId: pl.product_id, code: l.batchCode, expiry, dateType: s.date_type, quantity: d(l.quantity), poLineId: l.poLineId };
    });

    const receipt = await receiveGoods(tx, ctx, id, { date: input.date, rate: input.rate, lines: input.lines.map((l) => ({ poLineId: l.poLineId, quantity: l.quantity })) });
    const batches = [];
    for (const p of planned) {
      if (!p) continue;
      const batchId = await findOrCreateBatch(tx, ctx, {
        productId: p.productId, code: p.code, expiry: p.expiry, dateType: p.dateType, supplierId: po.supplier_id, receiptId: receipt.id, date: input.date,
      });
      await moveBatch(tx, ctx, {
        batchId, warehouseId: po.warehouse_id, date: input.date, kind: "receipt", quantity: p.quantity,
        sourceType: "goods_receipt", sourceId: receipt.id, sourceLineId: p.poLineId, contactId: po.supplier_id,
      });
      batches.push({ batchId, code: p.code, expiry: p.expiry, quantity: qty(p.quantity) });
    }
    await audit(tx, ctx, "fnb.batches.received", "goods_receipt", receipt.id, { batches });
    return reply.status(201).send({ ...receipt, batches });
  }));

  // ---------------------------------------------------------------- batch-aware invoicing (FEFO)
  app.post("/api/fnb/allocation-preview", (req) => inTenant(req, async (tx) => {
    const input = z.object({
      productId: uuid, quantity, date: isoDate.default(today()), warehouseId: uuid.optional(), customerId: uuid.optional(),
    }).parse(req.body);
    const warehouseId = await invoiceWarehouse(tx, input.warehouseId);
    const minLife = input.customerId ? await minLifeDays(tx, input.customerId) : 0;
    const settings = await trackedSettings(tx, [input.productId]);
    if (!settings.size) throw unprocessable("This product is not batch-tracked");
    const batches = await batchStock(tx, input.productId, warehouseId);
    try {
      const allocation = allocateFefo(batches, input.quantity, { today: input.date, minLifeDays: minLife });
      return { minLifeDays: minLife, allocation: allocation.map((a) => ({ ...a, quantity: qty(a.quantity) })) };
    } catch (e) {
      allocationError(e, "Cannot allocate");
    }
  }));

  async function salesDocument(req: FastifyRequest, tx: Sql, ctx: Ctx, kind: "invoice" | "credit") {
    requireWrite(ctx, "finance");
    const input = FnbInvoiceInput.parse(req.body);
    const warehouseId = await invoiceWarehouse(tx, input.warehouseId);
    const coreInput = { ...input, warehouseId, lines: input.lines.map(({ batches: _b, ...l }) => l) };

    if (kind === "invoice") {
      const allocations = await allocateLines(tx, warehouseId, input.date, await minLifeDays(tx, input.customerId), input.lines);
      const doc = await createSalesDocument(tx, ctx, "invoice", coreInput);
      const lineIds = await invoiceLineIds(tx, doc.id);
      const out = [];
      for (const [i, alloc] of allocations.entries()) {
        for (const a of alloc ?? []) {
          await moveBatch(tx, ctx, {
            batchId: a.batchId, warehouseId, date: input.date, kind: "dispatch", quantity: a.quantity.neg(),
            sourceType: "sales_invoice", sourceId: doc.id, sourceLineId: lineIds[i], contactId: input.customerId,
          });
          out.push({ line: i + 1, batchId: a.batchId, code: a.code, expiry: a.expiry, quantity: qty(a.quantity), pastBestBefore: a.pastBestBefore });
        }
      }
      await audit(tx, ctx, "fnb.batches.dispatched", "sales_invoice", doc.id, { allocations: out });
      return { ...doc, allocations: out };
    }

    // Credit note: goods returned to stock go back into a named batch that this customer was supplied from.
    const settings = await trackedSettings(tx, input.lines.flatMap((l) => (l.productId && l.returnToStock ? [l.productId] : [])));
    const returns: { line: number; productId: string; picks: { batchId: string; quantity: string }[] }[] = [];
    for (const [i, l] of input.lines.entries()) {
      const tracked = l.productId && l.returnToStock && settings.has(l.productId);
      if (!tracked) {
        if (l.batches) throw unprocessable(`Line ${i + 1}: batches are only recorded for batch-tracked goods returned to stock`);
        continue;
      }
      if (!l.batches) throw unprocessable(`Line ${i + 1}: say which batch the returned goods belong to`);
      const total = sum(l.batches.map((b) => b.quantity));
      if (!total.equals(l.quantity)) throw unprocessable(`Line ${i + 1}: batch quantities add up to ${total.toString()}, but the line is for ${l.quantity}`);
      for (const b of l.batches) {
        const [row] = await tx.query<{ product_id: string; code: string; supplied: string }>(
          `SELECT b.product_id, b.code,
                  coalesce((SELECT -sum(quantity) FROM fnb_batch_movements m
                             WHERE m.batch_id = b.id AND m.contact_id = $2 AND m.kind IN ('dispatch','return')), 0) AS supplied
             FROM fnb_batches b WHERE b.id = $1`, [b.batchId, input.customerId]);
        if (!row || row.product_id !== l.productId) throw unprocessable(`Line ${i + 1}: the batch does not belong to this product`);
        if (d(b.quantity).greaterThan(row.supplied)) {
          throw unprocessable(`Line ${i + 1}: only ${d(row.supplied).toString()} of batch ${row.code} was supplied to this customer`);
        }
      }
      returns.push({ line: i, productId: l.productId!, picks: l.batches });
    }
    const doc = await createSalesDocument(tx, ctx, "credit", coreInput);
    const lineIds = await invoiceLineIds(tx, doc.id);
    for (const r of returns) {
      for (const p of r.picks) {
        await moveBatch(tx, ctx, {
          batchId: p.batchId, warehouseId, date: input.date, kind: "return", quantity: d(p.quantity),
          sourceType: "sales_invoice", sourceId: doc.id, sourceLineId: lineIds[r.line], contactId: input.customerId,
        });
      }
    }
    if (returns.length) await audit(tx, ctx, "fnb.batches.returned", "sales_invoice", doc.id, { returns });
    return doc;
  }

  app.post("/api/fnb/sales-invoices", (req, reply) => inTenant(req, async (tx, ctx) =>
    reply.status(201).send(await salesDocument(req, tx, ctx, "invoice"))));

  app.post("/api/fnb/credit-notes", (req, reply) => inTenant(req, async (tx, ctx) =>
    reply.status(201).send(await salesDocument(req, tx, ctx, "credit"))));

  /** Batches dispatched on a sales invoice, for the invoice screen and delivery note. */
  app.get("/api/fnb/sales-invoices/:id/batches", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    return tx.query(
      `SELECT l.line_no, p.sku, b.id AS batch_id, b.code, b.expiry, b.date_type, -m.quantity AS quantity
         FROM fnb_batch_movements m JOIN fnb_batches b ON b.id = m.batch_id JOIN products p ON p.id = b.product_id
         LEFT JOIN sales_invoice_lines l ON l.id = m.source_line_id
        WHERE m.source_type = 'sales_invoice' AND m.source_id = $1 ORDER BY l.line_no, b.expiry`, [id]);
  }));

  // ---------------------------------------------------------------- batches, write-offs and reports
  app.get("/api/fnb/batches", (req) => inTenant(req, async (tx) => {
    const q = z.object({ productId: uuid.optional(), inStock: z.enum(["true", "false"]).optional(), search: z.string().max(60).optional() }).parse(req.query);
    const asAt = today();
    const rows = await tx.query<{ expiry: string | null; date_type: "use_by" | "best_before"; on_hand: string } & Record<string, unknown>>(
      `SELECT b.id, b.code, b.expiry, b.date_type, b.received_on, p.id AS product_id, p.sku, p.name AS product_name,
              c.name AS supplier_name, coalesce((SELECT sum(quantity) FROM fnb_batch_balances bb WHERE bb.batch_id = b.id), 0) AS on_hand
         FROM fnb_batches b JOIN products p ON p.id = b.product_id LEFT JOIN contacts c ON c.id = b.supplier_id
        WHERE ($1::uuid IS NULL OR b.product_id = $1)
          AND ($2::text IS NULL OR b.code ILIKE '%' || $2 || '%' OR p.sku ILIKE '%' || $2 || '%' OR p.name ILIKE '%' || $2 || '%')
        ORDER BY b.expiry NULLS LAST, p.sku, b.code`,
      [q.productId ?? null, q.search?.trim() || null]);
    return rows
      .map((r) => ({ ...r, status: batchStatus({ expiry: r.expiry, dateType: r.date_type }, asAt) }))
      .filter((r) => q.inStock !== "true" || d(r.on_hand).isPositive());
  }));

  async function trace(tx: Sql, batchId: string) {
    const [batch] = await tx.query<Record<string, unknown> & { expiry: string | null; date_type: "use_by" | "best_before" }>(
      `SELECT b.*, p.sku, p.name AS product_name, c.name AS supplier_name, c.email AS supplier_email, c.phone AS supplier_phone,
              r.number AS receipt_number, po.number AS po_number
         FROM fnb_batches b JOIN products p ON p.id = b.product_id LEFT JOIN contacts c ON c.id = b.supplier_id
         LEFT JOIN goods_receipts r ON r.id = b.receipt_id LEFT JOIN purchase_orders po ON po.id = r.po_id
        WHERE b.id = $1`, [batchId]);
    if (!batch) throw notFound("Batch");
    const movements = await tx.query<{
      kind: "receipt" | "dispatch" | "return" | "write_off" | "adjustment"; quantity: string; date: string;
      contact_id: string | null; contact_name: string | null; document: string | null;
    } & Record<string, unknown>>(
      `SELECT m.id, m.date, m.kind, m.quantity, m.source_type, m.source_id, w.code AS warehouse, m.contact_id, c.name AS contact_name,
              c.email AS contact_email, c.phone AS contact_phone,
              coalesce(si.number, gr.number) AS document
         FROM fnb_batch_movements m JOIN warehouses w ON w.id = m.warehouse_id LEFT JOIN contacts c ON c.id = m.contact_id
         LEFT JOIN sales_invoices si ON m.source_type = 'sales_invoice' AND si.id = m.source_id
         LEFT JOIN goods_receipts gr ON m.source_type = 'goods_receipt' AND gr.id = m.source_id
        WHERE m.batch_id = $1 ORDER BY m.date, m.created_at`, [batchId]);
    const summary = summariseTrace(movements.map((m) => ({
      kind: m.kind, quantity: m.quantity, date: m.date, contactId: m.contact_id, contactName: m.contact_name, document: m.document,
    })));
    const contacts = new Map(movements.map((m) => [m.contact_id, m]));
    return {
      batch: { ...batch, status: batchStatus({ expiry: batch.expiry, dateType: batch.date_type }, today()) },
      supplier: batch.supplier_id
        ? { id: batch.supplier_id, name: batch.supplier_name, email: batch.supplier_email, phone: batch.supplier_phone,
          receipt: batch.receipt_number, purchaseOrder: batch.po_number }
        : null,
      totals: {
        received: qty(summary.received), dispatched: qty(summary.dispatched), returned: qty(summary.returned),
        writtenOff: qty(summary.writtenOff), onHand: qty(summary.onHand),
      },
      customers: summary.customers.map((c) => ({
        id: c.contactId, name: c.contactName, quantity: qty(c.quantity), firstDate: c.firstDate, lastDate: c.lastDate, documents: c.documents,
        email: contacts.get(c.contactId)?.contact_email ?? null, phone: contacts.get(c.contactId)?.contact_phone ?? null,
      })),
      movements,
    };
  }

  app.get("/api/fnb/batches/:id", (req) => inTenant(req, async (tx) => trace(tx, IdParams.parse(req.params).id)));

  /** Recall trace: one step back (supplier and receipt) and one step forward (every customer supplied). */
  app.get("/api/fnb/recall-trace", (req) => inTenant(req, async (tx) => {
    const q = z.object({ batchId: uuid.optional(), sku: z.string().max(60).optional(), code: z.string().max(60).optional() }).parse(req.query);
    let batchId = q.batchId;
    if (!batchId) {
      if (!q.sku || !q.code) throw unprocessable("Give a batch id, or a SKU and batch code");
      const [b] = await tx.query<{ id: string }>(
        "SELECT b.id FROM fnb_batches b JOIN products p ON p.id = b.product_id WHERE p.sku = $1 AND b.code = $2", [q.sku, q.code]);
      if (!b) throw notFound("Batch");
      batchId = b.id;
    }
    return { generatedAt: new Date().toISOString(), ...await trace(tx, batchId) };
  }));

  app.post("/api/fnb/batches/:id/write-off", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const input = z.object({ date: isoDate, quantity, warehouseId: uuid.optional(), reason: z.string().trim().min(1).max(200) }).parse(req.body);
    const [batch] = await tx.query<{ product_id: string; code: string }>("SELECT product_id, code FROM fnb_batches WHERE id = $1", [id]);
    if (!batch) throw notFound("Batch");
    const warehouseId = await invoiceWarehouse(tx, input.warehouseId);
    const [bal] = await tx.query<{ quantity: string }>(
      "SELECT quantity FROM fnb_batch_balances WHERE batch_id = $1 AND warehouse_id = $2 FOR UPDATE", [id, warehouseId]);
    if (!bal || d(input.quantity).greaterThan(bal.quantity)) {
      throw unprocessable(`Batch ${batch.code} has only ${d(bal?.quantity ?? 0).toString()} in this warehouse`);
    }
    await tx.query(
      `INSERT INTO accounts (tenant_id, code, name, type) VALUES ($1,$2,$3,'expense') ON CONFLICT (tenant_id, code) DO NOTHING`,
      [ctx.tenantId, WASTE_ACCOUNT.code, WASTE_ACCOUNT.name]);
    const adjId = newId();
    const entryId = newId();
    const cost = await stockOut(tx, ctx, batch.product_id, warehouseId, input.quantity,
      { date: input.date, sourceType: "stock_adjustment", sourceId: adjId, entryId }, "adjustment");
    const posting = postStockAdjustment(await loadRoles(tx), {
      date: input.date, reference: `write-off batch ${batch.code}: ${input.reason}`, valueGbp: cost.neg(), offsetAccount: WASTE_ACCOUNT.code,
    });
    const entry = await postJournal(tx, ctx, posting, { type: "stock_adjustment", id: adjId, entryId });
    await moveBatch(tx, ctx, {
      batchId: id, warehouseId, date: input.date, kind: "write_off", quantity: d(input.quantity).neg(), sourceType: "stock_adjustment", sourceId: adjId,
    });
    await audit(tx, ctx, "fnb.batch.written_off", "fnb_batch", id, { ...input, value: toFixed(cost) });
    return reply.status(201).send({ id: adjId, entry: entry.number, value: toFixed(cost) });
  }));

  /** Stock by batch with days to expiry, plus a check that batches add up to the stock ledger for every tracked product. */
  app.get("/api/fnb/reports/expiry", (req) => inTenant(req, async (tx) => {
    const q = z.object({ asAt: isoDate.optional(), warnDays: z.coerce.number().int().min(0).max(365).default(7) }).parse(req.query);
    const asAt = q.asAt ?? today();
    const rows = await tx.query<{ expiry: string | null; date_type: "use_by" | "best_before"; quantity: string; average_cost: string } & Record<string, unknown>>(
      `SELECT b.id AS batch_id, b.code, b.expiry, b.date_type, p.id AS product_id, p.sku, p.name AS product_name, w.code AS warehouse,
              bb.quantity, c.name AS supplier_name,
              CASE WHEN sb.quantity > 0 THEN round(sb.value / sb.quantity, 6) ELSE 0 END AS average_cost
         FROM fnb_batch_balances bb JOIN fnb_batches b ON b.id = bb.batch_id JOIN products p ON p.id = b.product_id
         JOIN warehouses w ON w.id = bb.warehouse_id LEFT JOIN contacts c ON c.id = b.supplier_id
         LEFT JOIN stock_balances sb ON sb.product_id = b.product_id AND sb.warehouse_id = bb.warehouse_id
        WHERE bb.quantity > 0 ORDER BY b.expiry NULLS LAST, p.sku, b.code`);
    const out = rows.map((r) => ({
      ...r,
      daysLeft: r.expiry ? daysBetween(asAt, r.expiry) : null,
      status: batchStatus({ expiry: r.expiry, dateType: r.date_type }, asAt, q.warnDays),
      blocked: unsellableReason({ code: r.code as string, expiry: r.expiry, dateType: r.date_type }, { today: asAt }) !== null,
      // Estimated at the current weighted-average cost (batches carry quantity, not value).
      value: toFixed(d(r.quantity).times(r.average_cost)),
    }));
    const total = (status: string) => {
      const sel = out.filter((r) => r.status === status);
      return { batches: sel.length, value: toFixed(sum(sel.map((r) => r.value))) };
    };
    const checks = await tx.query<{ sku: string; warehouse: string; stock: string; batches: string }>(
      `SELECT p.sku, w.code AS warehouse, coalesce(sb.quantity, 0) AS stock,
              coalesce((SELECT sum(bb.quantity) FROM fnb_batch_balances bb JOIN fnb_batches b ON b.id = bb.batch_id
                         WHERE b.product_id = p.id AND bb.warehouse_id = w.id), 0) AS batches
         FROM fnb_product_settings s JOIN products p ON p.id = s.product_id CROSS JOIN warehouses w
         LEFT JOIN stock_balances sb ON sb.product_id = p.id AND sb.warehouse_id = w.id
        WHERE s.batch_tracked ORDER BY p.sku, w.code`);
    const mismatches = checks.filter((c) => !d(c.stock).equals(c.batches));
    return {
      asAt, warnDays: q.warnDays, rows: out,
      summary: { expired: total("expired"), expiring: total("expiring"), pastBestBefore: total("past_best_before"), ok: total("ok"), noDate: total("no_date") },
      integrity: { reconciled: mismatches.length === 0, mismatches },
    };
  }));
}
