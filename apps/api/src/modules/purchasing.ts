import { newId, type Sql } from "@softilo/db";
import {
  allocateLandedCosts, d, lineVat, postGoodsReceipt, postLandedCost, postStockAdjustment, postSupplierBill,
  round2, round6, sum, toBase, toFixed, type BillLine, type Dec,
} from "@softilo/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inTenant, requireWrite, type Ctx } from "../lib/context.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { audit, loadRoles, nextNumber, postJournal } from "../lib/ledger.js";
import {
  accountCode, addDays, checkRate, currency, IdParams, isoDate, money, positiveMoney, quantity, rate, unitPrice, uuid, vatCode,
} from "../lib/schemas.js";
import { position, stockIn, stockOut, stockRevalue } from "../lib/stock.js";

const PoInput = z.object({
  supplierId: uuid,
  warehouseId: uuid.optional(),
  date: isoDate,
  expectedDate: isoDate.optional(),
  currency: currency.optional(),
  rate: rate.optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(z.object({
    productId: uuid,
    description: z.string().max(500).optional(),
    quantity,
    unitPrice,
    vatCode: vatCode.optional(),
  })).min(1).max(500),
});

const ReceiveInput = z.object({
  date: isoDate,
  rate: rate.optional(),
  lines: z.array(z.object({ poLineId: uuid, quantity })).min(1),
});

const BillInput = z.object({
  kind: z.enum(["bill", "credit"]).default("bill"),
  supplierId: uuid,
  supplierRef: z.string().trim().min(1).max(60),
  date: isoDate,
  dueDate: isoDate.optional(),
  currency: currency.optional(),
  rate: rate.optional(),
  lines: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("receipt"), receiptLineId: uuid, net: money.optional(), vatCode: vatCode.optional() }),
    z.object({ kind: z.literal("account"), accountCode, description: z.string().trim().min(1).max(500), net: money, vatCode }),
  ])).min(1).max(500),
});

const ShipmentInput = z.object({
  reference: z.string().trim().max(60).optional(),
  mrn: z.string().trim().max(30).optional(),
  date: isoDate,
  receiptLineIds: z.array(uuid).min(1),
});

const CostInput = z.object({
  description: z.string().trim().min(1).max(200),
  amountGbp: positiveMoney,
  method: z.enum(["value", "weight", "volume", "quantity"]),
});

async function defaultWarehouse(tx: Sql): Promise<string> {
  const [w] = await tx.query<{ id: string }>("SELECT id FROM warehouses ORDER BY code = 'MAIN' DESC, code LIMIT 1");
  if (!w) throw unprocessable("Create a warehouse first");
  return w.id;
}

async function supplier(tx: Sql, id: string) {
  const [s] = await tx.query<{ id: string; currency: string; payment_terms_days: number; kind: string }>(
    "SELECT id, currency, payment_terms_days, kind FROM contacts WHERE id = $1 AND NOT archived", [id]);
  if (!s || s.kind === "customer") throw unprocessable("Supplier not found");
  return s;
}

export async function createBill(tx: Sql, ctx: Ctx, input: z.infer<typeof BillInput>) {
  const sup = await supplier(tx, input.supplierId);
  const cur = input.currency ?? sup.currency;
  const r = checkRate(cur, input.rate);
  const sign = input.kind === "credit" ? -1 : 1;
  const [dup] = await tx.query("SELECT 1 FROM supplier_bills WHERE supplier_id = $1 AND supplier_ref = $2 AND kind = $3",
    [sup.id, input.supplierRef, input.kind]);
  if (dup) throw unprocessable(`This supplier already has a ${input.kind} with reference ${input.supplierRef}`);

  const domainLines: BillLine[] = [];
  const stored: { kind: string; receiptLineId?: string; account?: string; description: string; net: string; vatCode: string; vat: Dec }[] = [];
  for (const l of input.lines) {
    if (l.kind === "receipt") {
      if (input.kind === "credit") throw unprocessable("Supplier credits are entered against accounts, not goods receipts");
      const [rl] = await tx.query<{ quantity: string; value_gbp: string; billed: boolean; unit_price: string; vat_code: string;
        supplier_id: string; currency: string; description: string }>(
        `SELECT gl.quantity, gl.value_gbp, gl.billed, pl.unit_price, pl.vat_code, po.supplier_id, po.currency, pl.description
           FROM goods_receipt_lines gl JOIN purchase_order_lines pl ON pl.id = gl.po_line_id
           JOIN purchase_orders po ON po.id = pl.po_id WHERE gl.id = $1 FOR UPDATE OF gl`, [l.receiptLineId]);
      if (!rl) throw unprocessable("Goods receipt line not found");
      if (rl.supplier_id !== sup.id) throw unprocessable("That goods receipt belongs to a different supplier");
      if (rl.currency !== cur) throw unprocessable(`That goods receipt was ordered in ${rl.currency}`);
      if (rl.billed) throw unprocessable(`"${rl.description}" has already been billed`);
      const net = l.net ?? toFixed(round2(d(rl.quantity).times(rl.unit_price)));
      const code = l.vatCode ?? (rl.vat_code as never);
      domainLines.push({ kind: "receipt", net, vatCode: code, grniValueGbp: rl.value_gbp, description: rl.description });
      stored.push({ kind: "receipt", receiptLineId: l.receiptLineId, description: rl.description, net, vatCode: code, vat: lineVat(net, code) });
      await tx.query("UPDATE goods_receipt_lines SET billed = true WHERE id = $1", [l.receiptLineId]);
    } else {
      const [a] = await tx.query<{ is_control: boolean; archived: boolean }>("SELECT is_control, archived FROM accounts WHERE code = $1", [l.accountCode]);
      if (!a || a.archived) throw unprocessable(`Account ${l.accountCode} does not exist`);
      if (a.is_control) throw unprocessable(`Account ${l.accountCode} is a control account`);
      domainLines.push({ kind: "account", net: l.net, vatCode: l.vatCode, account: l.accountCode, description: l.description });
      stored.push({ kind: "account", account: l.accountCode, description: l.description, net: l.net, vatCode: l.vatCode, vat: lineVat(l.net, l.vatCode) });
    }
  }

  const posting = postSupplierBill(await loadRoles(tx), { date: input.date, reference: input.supplierRef, rate: r, sign, lines: domainLines });
  const id = newId();
  const number = await nextNumber(tx, ctx, input.kind === "credit" ? "supplier_credit" : "supplier_bill");
  const entry = await postJournal(tx, ctx, posting, { type: "supplier_bill", id });
  const total = posting.total.abs();
  await tx.query(
    `INSERT INTO supplier_bills (id, tenant_id, number, kind, supplier_id, supplier_ref, date, due_date, currency, rate, total, total_gbp, entry_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, ctx.tenantId, number, input.kind, sup.id, input.supplierRef, input.date,
      input.dueDate ?? addDays(input.date, sup.payment_terms_days), cur, r, toFixed(total), toFixed(posting.totalGbp.abs()), entry.id],
  );
  let n = 1;
  for (const l of stored) {
    await tx.query(
      `INSERT INTO supplier_bill_lines (id, tenant_id, bill_id, line_no, kind, receipt_line_id, account_code, description, net, vat_code, vat)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [newId(), ctx.tenantId, id, n++, l.kind, l.receiptLineId ?? null, l.account ?? null, l.description, l.net, l.vatCode, toFixed(l.vat)],
    );
  }
  await audit(tx, ctx, `supplier_${input.kind}.posted`, "supplier_bill", id, { number, total: toFixed(total), currency: cur });
  return { id, number, entry: entry.number };
}

export async function registerPurchasing(app: FastifyInstance) {
  // ---------------------------------------------------------------- purchase orders
  app.get("/api/purchase-orders", (req) => inTenant(req, (tx) => tx.query(
    `SELECT po.*, c.name AS supplier_name,
            (SELECT sum(round(quantity * unit_price, 2)) FROM purchase_order_lines l WHERE l.po_id = po.id) AS total
       FROM purchase_orders po JOIN contacts c ON c.id = po.supplier_id ORDER BY po.date DESC, po.number DESC`)));

  app.get("/api/purchase-orders/:id", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const [po] = await tx.query(
      `SELECT po.*, c.name AS supplier_name, w.name AS warehouse_name FROM purchase_orders po
         JOIN contacts c ON c.id = po.supplier_id JOIN warehouses w ON w.id = po.warehouse_id WHERE po.id = $1`, [id]);
    if (!po) throw notFound("Purchase order");
    const lines = await tx.query(
      `SELECT l.*, p.sku FROM purchase_order_lines l JOIN products p ON p.id = l.product_id WHERE l.po_id = $1 ORDER BY line_no`, [id]);
    const receipts = await tx.query(
      `SELECT r.id, r.number, r.date, gl.id AS line_id, gl.quantity, gl.value_gbp, gl.billed, gl.shipment_id, pl.description
         FROM goods_receipts r JOIN goods_receipt_lines gl ON gl.receipt_id = r.id
         JOIN purchase_order_lines pl ON pl.id = gl.po_line_id WHERE r.po_id = $1 ORDER BY r.date, r.number`, [id]);
    return { ...po, lines, receipts };
  }));

  app.post("/api/purchase-orders", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const input = PoInput.parse(req.body);
    const sup = await supplier(tx, input.supplierId);
    const cur = input.currency ?? sup.currency;
    const r = checkRate(cur, input.rate);
    const id = newId();
    const number = await nextNumber(tx, ctx, "purchase_order");
    await tx.query(
      `INSERT INTO purchase_orders (id, tenant_id, number, supplier_id, warehouse_id, date, expected_date, currency, rate, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10)`,
      [id, ctx.tenantId, number, sup.id, input.warehouseId ?? await defaultWarehouse(tx), input.date,
        input.expectedDate ?? null, cur, r, input.notes ?? null],
    );
    let n = 1;
    for (const l of input.lines) {
      const [p] = await tx.query<{ name: string; purchase_vat_code: string; track_stock: boolean }>(
        "SELECT name, purchase_vat_code, track_stock FROM products WHERE id = $1 AND NOT archived", [l.productId]);
      if (!p) throw unprocessable("Product not found");
      if (!p.track_stock) throw unprocessable(`${p.name} is not a stock item; bill it directly to an expense account`);
      await tx.query(
        `INSERT INTO purchase_order_lines (id, tenant_id, po_id, line_no, product_id, description, quantity, unit_price, vat_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [newId(), ctx.tenantId, id, n++, l.productId, l.description ?? p.name, l.quantity, l.unitPrice, l.vatCode ?? p.purchase_vat_code],
      );
    }
    await audit(tx, ctx, "purchase_order.created", "purchase_order", id, { number });
    return reply.status(201).send({ id, number });
  }));

  app.post("/api/purchase-orders/:id/approve", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const rows = await tx.query("UPDATE purchase_orders SET status = 'approved' WHERE id = $1 AND status = 'draft' RETURNING number", [id]);
    if (!rows.length) throw unprocessable("Only draft purchase orders can be approved");
    await audit(tx, ctx, "purchase_order.approved", "purchase_order", id);
    return { ok: true };
  }));

  app.post("/api/purchase-orders/:id/cancel", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const rows = await tx.query("UPDATE purchase_orders SET status = 'cancelled' WHERE id = $1 AND status IN ('draft','approved') RETURNING id", [id]);
    if (!rows.length) throw unprocessable("Only purchase orders with nothing received can be cancelled");
    await audit(tx, ctx, "purchase_order.cancelled", "purchase_order", id);
    return { ok: true };
  }));

  app.post("/api/purchase-orders/:id/receive", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const input = ReceiveInput.parse(req.body);
    const [po] = await tx.query<{ status: string; rate: string; warehouse_id: string; number: string }>(
      "SELECT status, rate, warehouse_id, number FROM purchase_orders WHERE id = $1 FOR UPDATE", [id]);
    if (!po) throw notFound("Purchase order");
    if (!["approved", "part_received"].includes(po.status)) throw unprocessable("Approve the purchase order before receiving goods");
    const r = input.rate ?? po.rate;

    const receiptId = newId();
    const entryId = newId();
    const number = await nextNumber(tx, ctx, "goods_receipt");
    const grnLines: { valueGbp: Dec; description: string }[] = [];
    const src = { date: input.date, sourceType: "goods_receipt", sourceId: receiptId, entryId };
    const toInsert: unknown[][] = [];
    for (const l of input.lines) {
      const [pl] = await tx.query<{ product_id: string; quantity: string; received_qty: string; unit_price: string; description: string }>(
        "SELECT product_id, quantity, received_qty, unit_price, description FROM purchase_order_lines WHERE id = $1 AND po_id = $2 FOR UPDATE",
        [l.poLineId, id]);
      if (!pl) throw unprocessable("Purchase order line not found");
      const outstanding = d(pl.quantity).minus(pl.received_qty);
      if (d(l.quantity).greaterThan(outstanding)) throw unprocessable(`Only ${outstanding.toString()} of "${pl.description}" is outstanding`);
      const valueGbp = toBase(d(l.quantity).times(pl.unit_price), r);
      await stockIn(tx, ctx, pl.product_id, po.warehouse_id, l.quantity, valueGbp, "receipt", src);
      await tx.query("UPDATE purchase_order_lines SET received_qty = received_qty + $2 WHERE id = $1", [l.poLineId, l.quantity]);
      grnLines.push({ valueGbp, description: pl.description });
      toInsert.push([newId(), ctx.tenantId, receiptId, l.poLineId, pl.product_id, l.quantity,
        toFixed(round6(d(pl.unit_price).times(r)), 6), toFixed(valueGbp)]);
    }
    const posting = postGoodsReceipt(await loadRoles(tx), { date: input.date, reference: `${number} (${po.number})`, lines: grnLines });
    await postJournal(tx, ctx, posting, { type: "goods_receipt", id: receiptId, entryId });
    await tx.query(
      "INSERT INTO goods_receipts (id, tenant_id, number, po_id, warehouse_id, date, entry_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [receiptId, ctx.tenantId, number, id, po.warehouse_id, input.date, entryId]);
    for (const row of toInsert) {
      await tx.query(
        `INSERT INTO goods_receipt_lines (id, tenant_id, receipt_id, po_line_id, product_id, quantity, unit_cost_gbp, value_gbp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, row);
    }
    const [open] = await tx.query("SELECT 1 FROM purchase_order_lines WHERE po_id = $1 AND received_qty < quantity LIMIT 1", [id]);
    await tx.query("UPDATE purchase_orders SET status = $2 WHERE id = $1", [id, open ? "part_received" : "received"]);
    await audit(tx, ctx, "goods_receipt.posted", "goods_receipt", receiptId, { number, po: po.number });
    return reply.status(201).send({ id: receiptId, number });
  }));

  /** Receipt lines not yet billed, for building a supplier bill. */
  app.get("/api/goods-receipts/unbilled", (req) => inTenant(req, async (tx) => {
    const q = z.object({ supplierId: uuid.optional() }).parse(req.query);
    return tx.query(
      `SELECT gl.id, r.number AS receipt_number, r.date, po.number AS po_number, po.currency, po.supplier_id, c.name AS supplier_name,
              pl.description, gl.quantity, pl.unit_price, round(gl.quantity * pl.unit_price, 2) AS net, pl.vat_code, gl.value_gbp,
              p.sku, gl.shipment_id
         FROM goods_receipt_lines gl JOIN goods_receipts r ON r.id = gl.receipt_id
         JOIN purchase_order_lines pl ON pl.id = gl.po_line_id JOIN purchase_orders po ON po.id = pl.po_id
         JOIN contacts c ON c.id = po.supplier_id JOIN products p ON p.id = gl.product_id
        WHERE NOT gl.billed AND ($1::uuid IS NULL OR po.supplier_id = $1) ORDER BY r.date, r.number`,
      [q.supplierId ?? null]);
  }));

  /** Receipt lines not yet on a shipment, for grouping into one. */
  app.get("/api/goods-receipts/unshipped", (req) => inTenant(req, async (tx) => {
    const q = z.object({ poId: uuid.optional() }).parse(req.query);
    return tx.query(
      `SELECT gl.id, r.number AS receipt_number, r.date, po.id AS po_id, po.number AS po_number, c.name AS supplier_name,
              p.sku, pl.description, gl.quantity, gl.value_gbp
         FROM goods_receipt_lines gl JOIN goods_receipts r ON r.id = gl.receipt_id
         JOIN purchase_order_lines pl ON pl.id = gl.po_line_id JOIN purchase_orders po ON po.id = pl.po_id
         JOIN contacts c ON c.id = po.supplier_id JOIN products p ON p.id = gl.product_id
        WHERE gl.shipment_id IS NULL AND ($1::uuid IS NULL OR po.id = $1) ORDER BY r.date DESC, r.number, p.sku`,
      [q.poId ?? null]);
  }));

  // ---------------------------------------------------------------- supplier bills
  app.get("/api/supplier-bills", (req) => inTenant(req, (tx) => tx.query(
    `SELECT b.*, c.name AS supplier_name, b.total - b.amount_paid AS outstanding FROM supplier_bills b
       JOIN contacts c ON c.id = b.supplier_id ORDER BY b.date DESC, b.number DESC`)));

  app.get("/api/supplier-bills/:id", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const [b] = await tx.query(
      `SELECT b.*, c.name AS supplier_name, e.number AS journal_number, b.total - b.amount_paid AS outstanding
         FROM supplier_bills b JOIN contacts c ON c.id = b.supplier_id JOIN journal_entries e ON e.id = b.entry_id WHERE b.id = $1`, [id]);
    if (!b) throw notFound("Supplier bill");
    const lines = await tx.query("SELECT * FROM supplier_bill_lines WHERE bill_id = $1 ORDER BY line_no", [id]);
    return { ...b, lines };
  }));

  app.post("/api/supplier-bills", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    return reply.status(201).send(await createBill(tx, ctx, BillInput.parse(req.body)));
  }));

  // ---------------------------------------------------------------- shipments & landed cost
  app.get("/api/shipments", (req) => inTenant(req, (tx) => tx.query(
    `SELECT s.*, (SELECT count(*) FROM goods_receipt_lines g WHERE g.shipment_id = s.id) AS lines,
            (SELECT coalesce(sum(value_gbp), 0) FROM goods_receipt_lines g WHERE g.shipment_id = s.id) AS goods_value,
            (SELECT coalesce(sum(amount_gbp), 0) FROM shipment_costs c WHERE c.shipment_id = s.id) AS costs
       FROM shipments s ORDER BY s.date DESC, s.number DESC`)));

  async function shipmentDetail(tx: Sql, id: string) {
    const [s] = await tx.query<Record<string, unknown> & { status: string }>("SELECT * FROM shipments WHERE id = $1", [id]);
    if (!s) throw notFound("Shipment");
    const lines = await tx.query<{ id: string; product_id: string; quantity: string; value_gbp: string; weight_kg: string | null;
      volume_m3: string | null; sku: string; description: string; warehouse_id: string }>(
      `SELECT gl.id, gl.product_id, gl.quantity, gl.value_gbp, p.weight_kg, p.volume_m3, p.sku, pl.description, r.warehouse_id
         FROM goods_receipt_lines gl JOIN products p ON p.id = gl.product_id
         JOIN purchase_order_lines pl ON pl.id = gl.po_line_id JOIN goods_receipts r ON r.id = gl.receipt_id
        WHERE gl.shipment_id = $1 ORDER BY p.sku`, [id]);
    const costs = await tx.query<{ id: string; description: string; amount_gbp: string; method: "value" | "weight" | "volume" | "quantity" }>(
      "SELECT * FROM shipment_costs WHERE shipment_id = $1 ORDER BY description", [id]);
    const allocate = () => allocateLandedCosts(
      lines.map((l) => ({
        id: l.id, quantity: l.quantity, value: l.value_gbp,
        weight: d(l.weight_kg ?? 0).times(l.quantity), volume: d(l.volume_m3 ?? 0).times(l.quantity),
      })),
      costs.map((c) => ({ id: c.id, amount: c.amount_gbp, method: c.method })),
    );
    let allocations: ReturnType<typeof allocate> = [];
    try {
      if (costs.length) allocations = allocate();
    } catch (e) {
      // e.g. allocating by weight when no product on the shipment has a weight.
      throw unprocessable((e as Error).message);
    }
    const perLine = lines.map((l) => {
      const landed = sum(allocations.filter((a) => a.receiptLineId === l.id).map((a) => a.amount));
      const total = d(l.value_gbp).plus(landed);
      return { ...l, landed: toFixed(landed), total: toFixed(total), unit_landed_cost: toFixed(round6(total.dividedBy(l.quantity)), 6) };
    });
    return { shipment: s, lines: perLine, costs, allocations };
  }

  app.get("/api/shipments/:id", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const r = await shipmentDetail(tx, id);
    return { ...r.shipment, lines: r.lines, costs: r.costs };
  }));

  app.post("/api/shipments", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const input = ShipmentInput.parse(req.body);
    const id = newId();
    const number = await nextNumber(tx, ctx, "shipment");
    await tx.query("INSERT INTO shipments (id, tenant_id, number, reference, mrn, date, status) VALUES ($1,$2,$3,$4,$5,$6,'open')",
      [id, ctx.tenantId, number, input.reference ?? null, input.mrn ?? null, input.date]);
    for (const lineId of input.receiptLineIds) {
      const rows = await tx.query("UPDATE goods_receipt_lines SET shipment_id = $2 WHERE id = $1 AND shipment_id IS NULL RETURNING id", [lineId, id]);
      if (!rows.length) throw unprocessable("A receipt line is missing or already on another shipment");
    }
    await audit(tx, ctx, "shipment.created", "shipment", id, { number });
    return reply.status(201).send({ id, number });
  }));

  app.post("/api/shipments/:id/costs", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const c = CostInput.parse(req.body);
    const [s] = await tx.query<{ status: string }>("SELECT status FROM shipments WHERE id = $1", [id]);
    if (!s) throw notFound("Shipment");
    if (s.status !== "open") throw unprocessable("This shipment has already been costed");
    const costId = newId();
    await tx.query("INSERT INTO shipment_costs (id, tenant_id, shipment_id, description, amount_gbp, method) VALUES ($1,$2,$3,$4,$5,$6)",
      [costId, ctx.tenantId, id, c.description, c.amountGbp, c.method]);
    await audit(tx, ctx, "shipment.cost_added", "shipment", id, c);
    return reply.status(201).send({ id: costId });
  }));

  app.delete("/api/shipments/:id/costs/:costId", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id, costId } = z.object({ id: uuid, costId: uuid }).parse(req.params);
    const rows = await tx.query(
      `DELETE FROM shipment_costs c USING shipments s WHERE c.id = $2 AND c.shipment_id = $1 AND s.id = c.shipment_id AND s.status = 'open' RETURNING c.id`,
      [id, costId]);
    if (!rows.length) throw unprocessable("Cost not found, or the shipment is already costed");
    await audit(tx, ctx, "shipment.cost_removed", "shipment", id, { costId });
    return { ok: true };
  }));

  /**
   * Post landed costs: revalue stock still on hand, send the share on units already sold to cost of sales,
   * and clear the landed-cost clearing account (where freight/duty bills were posted).
   */
  app.post("/api/shipments/:id/post", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const { date } = z.object({ date: isoDate }).parse(req.body ?? {});
    const [locked] = await tx.query<{ status: string; number: string }>("SELECT status, number FROM shipments WHERE id = $1 FOR UPDATE", [id]);
    if (!locked) throw notFound("Shipment");
    if (locked.status !== "open") throw unprocessable("This shipment has already been costed");
    const { lines, costs, allocations } = await shipmentDetail(tx, id);
    if (!costs.length) throw unprocessable("Add at least one cost before posting");
    const entryId = newId();
    const src = { date, sourceType: "shipment", sourceId: id, entryId };
    let toStock = d(0);
    let toCogs = d(0);
    for (const l of lines) {
      const landed = d(l.landed);
      if (landed.isZero()) continue;
      const pos = await position(tx, l.product_id, l.warehouse_id);
      const heldQty = pos.quantity.lessThan(l.quantity) ? pos.quantity : d(l.quantity);
      const stockShare = round2(landed.times(heldQty).dividedBy(l.quantity));
      if (!stockShare.isZero()) await stockRevalue(tx, ctx, l.product_id, l.warehouse_id, stockShare, src);
      toStock = toStock.plus(stockShare);
      toCogs = toCogs.plus(landed.minus(stockShare));
    }
    const posting = postLandedCost(await loadRoles(tx), { date, reference: locked.number, stockGbp: toStock, cogsGbp: toCogs });
    await postJournal(tx, ctx, posting, { type: "shipment", id, entryId });
    for (const a of allocations) {
      await tx.query(
        "INSERT INTO landed_cost_allocations (id, tenant_id, shipment_id, cost_id, receipt_line_id, amount) VALUES ($1,$2,$3,$4,$5,$6)",
        [newId(), ctx.tenantId, id, a.costLineId, a.receiptLineId, toFixed(a.amount)]);
    }
    await tx.query("UPDATE shipments SET status = 'costed', entry_id = $2 WHERE id = $1", [id, entryId]);
    await audit(tx, ctx, "shipment.costed", "shipment", id, { stock: toFixed(toStock), cogs: toFixed(toCogs) });
    return { ok: true, stock: toFixed(toStock), cogs: toFixed(toCogs) };
  }));

  // ---------------------------------------------------------------- stock adjustments
  app.post("/api/stock/adjustments", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const input = z.object({
      date: isoDate,
      productId: uuid,
      warehouseId: uuid.optional(),
      quantity: z.union([z.string(), z.number()]).transform(String).refine((v) => /^-?\d{1,14}(\.\d{1,4})?$/.test(v) && Number(v) !== 0, "Non-zero quantity"),
      unitCostGbp: unitPrice.optional(),
      reason: z.string().trim().min(1).max(200),
      offsetAccount: accountCode.default("5000"),
    }).parse(req.body);
    const warehouseId = input.warehouseId ?? await defaultWarehouse(tx);
    const [a] = await tx.query<{ is_control: boolean }>("SELECT is_control FROM accounts WHERE code = $1", [input.offsetAccount]);
    if (!a || a.is_control) throw unprocessable("Choose a non-control account to post the adjustment against");
    const adjId = newId();
    const entryId = newId();
    const src = { date: input.date, sourceType: "stock_adjustment", sourceId: adjId, entryId };
    const qty = d(input.quantity);
    let value: Dec;
    if (qty.isPositive()) {
      const pos = await position(tx, input.productId, warehouseId);
      const unit = input.unitCostGbp ?? (pos.quantity.isZero() ? undefined : pos.value.dividedBy(pos.quantity).toString());
      if (unit === undefined) throw unprocessable("Give a unit cost: there is no average cost for this product yet");
      value = round2(qty.times(unit));
      await stockIn(tx, ctx, input.productId, warehouseId, qty, value, "adjustment", src);
    } else {
      value = (await stockOut(tx, ctx, input.productId, warehouseId, qty.neg(), src, "adjustment")).neg();
    }
    const posting = postStockAdjustment(await loadRoles(tx), { date: input.date, reference: input.reason, valueGbp: value, offsetAccount: input.offsetAccount });
    const entry = await postJournal(tx, ctx, posting, { type: "stock_adjustment", id: adjId, entryId });
    await audit(tx, ctx, "stock.adjusted", "product", input.productId, { ...input, value: toFixed(value) });
    return reply.status(201).send({ id: adjId, entry: entry.number, value: toFixed(value) });
  }));
}
