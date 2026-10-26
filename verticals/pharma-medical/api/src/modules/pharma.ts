import { newId, type Sql } from "@softilo/db";
import { d, sum, toFixed } from "@softilo/domain";
import {
  allocateFefo, allowedActions, BatchTransitionError, checkSupplyEligibility, expiryBand, InsufficientReleasedStockError,
  InvalidDateError, LICENCE_TYPES, licenceProblem, normaliseExpiry, transitionBatch,
  type Allocation, type BatchAction, type BatchStatus, type BatchStock, type CustomerLicence, type LicenceType, type ProductClass,
} from "@softilo/pharma-domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  audit, createSalesDocument, IdParams, inTenant, InvoiceInput, isoDate, notFound, quantity, rate, receiveGoods, requireWrite,
  today, unitPrice, unprocessable, uuid, vatCode, type Ctx,
} from "../core.js";

const ProductInput = z.object({
  kind: z.enum(["medicine", "device"]),
  legalCategory: z.enum(["POM", "P", "GSL"]).nullable().optional(),
  cdSchedule: z.number().int().min(1).max(5).nullable().optional(),
  storage: z.enum(["ambient", "cold_chain", "frozen"]).default("ambient"),
  batchTracked: z.boolean().default(true),
  licenceNumber: z.string().trim().max(40).nullable().optional(),
  deviceMark: z.enum(["UKCA", "CE", "CE_UKNI"]).nullable().optional(),
});

const LicenceInput = z.object({
  type: z.enum(Object.keys(LICENCE_TYPES) as [LicenceType, ...LicenceType[]]),
  number: z.string().trim().min(1).max(60),
  validFrom: isoDate.nullable().optional(),
  expiresOn: isoDate.nullable().optional(),
  verifiedOn: isoDate.nullable().optional(),
  verificationSource: z.string().trim().max(200).nullable().optional(),
});

const VerifyInput = z.object({ verifiedOn: isoDate, verificationSource: z.string().trim().min(1).max(200) });

const ReceiptInput = z.object({
  poId: uuid,
  date: isoDate,
  rate: rate.optional(),
  lines: z.array(z.object({
    poLineId: uuid,
    quantity,
    batchNumber: z.string().trim().max(40).optional(),
    expiry: z.string().trim().max(10).optional(),
    manufacturedOn: isoDate.optional(),
  })).min(1).max(500),
});

const DecisionInput = z.object({
  reason: z.string().trim().max(1000).optional(),
  reference: z.string().trim().max(100).optional(),
});

const RecallInput = z.object({
  productId: uuid,
  batchNumber: z.string().trim().min(1).max(40),
  reason: z.string().trim().min(1).max(1000),
  reference: z.string().trim().max(100).optional(),
});

const SupplyLines = z.array(z.object({ productId: uuid, quantity, unitPrice: unitPrice.optional(), vatCode: vatCode.optional() })).min(1).max(200);

const PreviewInput = z.object({ customerId: uuid, date: isoDate, warehouseId: uuid.optional(), lines: SupplyLines });

const DispatchInput = z.object({
  customerId: uuid,
  date: isoDate,
  warehouseId: uuid.optional(),
  customerRef: z.string().max(60).optional(),
  currency: z.string().length(3).optional(),
  rate: rate.optional(),
  lines: z.array(z.object({ productId: uuid, quantity, unitPrice, vatCode: vatCode.optional() })).min(1).max(200),
});

/** Turn domain rule failures into 422s with the rule's own message. */
async function rules<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BatchTransitionError || e instanceof InsufficientReleasedStockError || e instanceof InvalidDateError) {
      throw unprocessable(e.message);
    }
    throw e;
  }
}

async function isResponsiblePerson(tx: Sql, userId: string): Promise<boolean> {
  const [rp] = await tx.query("SELECT 1 FROM pharma_responsible_persons WHERE user_id = $1 AND active", [userId]);
  return Boolean(rp);
}

type PharmaProductRow = { id: string; sku: string; name: string; kind: "medicine" | "device" | null; legal_category: string | null;
  cd_schedule: number | null; batch_tracked: boolean | null };

async function productClass(tx: Sql, productId: string) {
  const [p] = await tx.query<PharmaProductRow>(
    `SELECT p.id, p.sku, p.name, pp.kind, pp.legal_category, pp.cd_schedule, pp.batch_tracked
       FROM products p LEFT JOIN pharma_products pp ON pp.product_id = p.id WHERE p.id = $1 AND NOT p.archived`, [productId]);
  if (!p) throw unprocessable("Product not found");
  if (!p.kind) throw unprocessable(`Classify ${p.sku} as a medicine or a device before supplying it`);
  const cls: ProductClass = { kind: p.kind, legalCategory: p.legal_category as ProductClass["legalCategory"], cdSchedule: p.cd_schedule };
  return { ...p, cls, tracked: Boolean(p.batch_tracked) };
}

async function customerLicences(tx: Sql, customerId: string): Promise<CustomerLicence[]> {
  const rows = await tx.query<{ id: string; type: LicenceType; number: string; valid_from: string | null; expires_on: string | null;
    verified_on: string | null; status: "active" | "suspended" }>(
    "SELECT id, type, number, valid_from, expires_on, verified_on, status FROM pharma_customer_licences WHERE contact_id = $1", [customerId]);
  return rows.map((r) => ({ id: r.id, type: r.type, number: r.number, validFrom: r.valid_from, expiresOn: r.expires_on, verifiedOn: r.verified_on, status: r.status }));
}

async function minShelfLife(tx: Sql, customerId: string): Promise<number> {
  const [p] = await tx.query<{ min_shelf_life_days: number }>("SELECT min_shelf_life_days FROM pharma_customer_profiles WHERE contact_id = $1", [customerId]);
  return p?.min_shelf_life_days ?? 0;
}

async function warehouseFor(tx: Sql, warehouseId?: string): Promise<string> {
  const [w] = warehouseId
    ? await tx.query<{ id: string }>("SELECT id FROM warehouses WHERE id = $1", [warehouseId])
    : await tx.query<{ id: string }>("SELECT id FROM warehouses ORDER BY code = 'MAIN' DESC, code LIMIT 1");
  if (!w) throw unprocessable("Warehouse not found");
  return w.id;
}

async function batchStock(tx: Sql, productId: string, warehouseId: string, lock: boolean): Promise<BatchStock[]> {
  const rows = await tx.query<{ id: string; batch_number: string; expiry: string; status: BatchStatus; on_hand: string; received_on: string }>(
    `SELECT id, batch_number, expiry, status, on_hand, received_on FROM pharma_batches
      WHERE product_id = $1 AND warehouse_id = $2 AND on_hand > 0 ORDER BY expiry, received_on ${lock ? "FOR UPDATE" : ""}`,
    [productId, warehouseId]);
  return rows.map((r) => ({ id: r.id, batchNumber: r.batch_number, expiry: r.expiry, status: r.status, onHand: r.on_hand, receivedOn: r.received_on }));
}

/**
 * Check every line of a supply: the customer's entitlement for each product, then FEFO across
 * released in-date batches. Quantities for the same product on several lines share the batches.
 */
async function planSupply(tx: Sql, customerId: string, date: string, warehouseId: string,
  lines: { productId: string; quantity: string }[], lock: boolean) {
  const [cust] = await tx.query<{ kind: string; name: string }>("SELECT kind, name FROM contacts WHERE id = $1 AND NOT archived", [customerId]);
  if (!cust || cust.kind === "supplier") throw unprocessable("Customer not found");
  const licences = await customerLicences(tx, customerId);
  const minDays = await minShelfLife(tx, customerId);
  const used = new Map<string, Map<string, string>>(); // productId → batchId → quantity already planned
  const relied = new Map<string, CustomerLicence>();
  const plan: { productId: string; sku: string; name: string; tracked: boolean; quantity: string;
    eligibility: ReturnType<typeof checkSupplyEligibility>; allocations: Allocation[]; error?: string }[] = [];
  for (const l of lines) {
    const p = await productClass(tx, l.productId);
    const eligibility = checkSupplyEligibility(p.cls, licences, { onDate: date });
    const row = { productId: p.id, sku: p.sku, name: p.name, tracked: p.tracked, quantity: l.quantity, eligibility, allocations: [] as Allocation[] } as (typeof plan)[number];
    if (!eligibility.ok) {
      row.error = eligibility.reason;
    } else {
      eligibility.licences.forEach((x) => relied.set(x.id ?? x.number, x));
      if (p.tracked) {
        const taken = used.get(p.id) ?? new Map<string, string>();
        const stock = (await batchStock(tx, p.id, warehouseId, lock))
          .map((b) => ({ ...b, onHand: d(b.onHand).minus(taken.get(b.id) ?? 0).toString() }));
        try {
          row.allocations = allocateFefo(stock, l.quantity, { onDate: date, minShelfLifeDays: minDays });
          for (const a of row.allocations) taken.set(a.batchId, d(taken.get(a.batchId) ?? 0).plus(a.quantity).toString());
          used.set(p.id, taken);
        } catch (e) {
          if (!(e instanceof InsufficientReleasedStockError)) throw e;
          row.error = `${p.sku}: ${e.message}`;
        }
      }
    }
    plan.push(row);
  }
  return { customer: cust.name, minShelfLifeDays: minDays, plan, licences: [...relied.values()] };
}

/** Product ids touched by a core stock route's body, so batch-tracked products can be routed to the pharma flows. */
async function batchTrackedIn(req: FastifyRequest): Promise<string | null> {
  const body = req.body as { lines?: { productId?: string; poLineId?: string }[]; productId?: string } | undefined;
  if (!body || !req.ctx) return null;
  const productIds = [body.productId, ...(body.lines ?? []).map((l) => l?.productId)].filter((x): x is string => typeof x === "string");
  const poLineIds = (body.lines ?? []).map((l) => l?.poLineId).filter((x): x is string => typeof x === "string");
  if (!productIds.length && !poLineIds.length) return null;
  const uuidRe = /^[0-9a-f-]{36}$/i;
  return inTenant(req, async (tx) => {
    const [hit] = await tx.query<{ sku: string }>(
      `SELECT p.sku FROM pharma_products pp JOIN products p ON p.id = pp.product_id
        WHERE pp.batch_tracked AND (p.id = ANY($1::uuid[])
           OR p.id IN (SELECT product_id FROM purchase_order_lines WHERE id = ANY($2::uuid[]))) LIMIT 1`,
      [productIds.filter((x) => uuidRe.test(x)), poLineIds.filter((x) => uuidRe.test(x))]);
    return hit?.sku ?? null;
  });
}

const GUARDED: Record<string, string> = {
  "/api/purchase-orders/:id/receive": "Receive it through Goods in (batches) so its batch and expiry are recorded",
  "/api/sales-invoices": "Supply it through Dispatch so a released batch is allocated first-expiry-first-out",
  "/api/credit-notes": "Customer returns of batch-tracked stock need the returns workflow, which is not built yet",
  "/api/stock/adjustments": "Stock adjustments of batch-tracked stock are not supported yet",
};

export async function registerPharma(app: FastifyInstance) {
  // Core routes that would move batch-tracked stock without batch detail are refused in this edition.
  app.addHook("preHandler", async (req) => {
    const hint = req.method === "POST" ? GUARDED[req.routeOptions.url ?? ""] : undefined;
    if (!hint) return;
    const sku = await batchTrackedIn(req);
    if (sku) throw unprocessable(`${sku} is batch-tracked. ${hint}.`);
  });

  // ---------------------------------------------------------------- overview
  app.get("/api/pharma/me", (req) => inTenant(req, async (tx, ctx) => ({ isResponsiblePerson: await isResponsiblePerson(tx, ctx.userId) })));

  app.get("/api/pharma/dashboard", (req) => inTenant(req, async (tx) => {
    const on = today();
    const [b] = await tx.query<{ quarantine: string; recalled: string; expiring: string; expired: string }>(
      `SELECT count(*) FILTER (WHERE status = 'quarantine') AS quarantine,
              count(*) FILTER (WHERE status = 'recalled') AS recalled,
              count(*) FILTER (WHERE status = 'released' AND expiry >= $1 AND expiry <= $1::date + 90) AS expiring,
              count(*) FILTER (WHERE status IN ('released','quarantine') AND expiry < $1) AS expired
         FROM pharma_batches WHERE on_hand > 0`, [on]);
    const licences = await tx.query<{ type: LicenceType; number: string; valid_from: string | null; expires_on: string | null;
      verified_on: string | null; status: "active" | "suspended" }>("SELECT * FROM pharma_customer_licences");
    const attention = licences.filter((l) => licenceProblem({ type: l.type, number: l.number, validFrom: l.valid_from,
      expiresOn: l.expires_on, verifiedOn: l.verified_on, status: l.status }, { onDate: on, reverifyDays: 335 })).length;
    return { ...b, licencesNeedingAttention: attention };
  }));

  // ---------------------------------------------------------------- products
  app.get("/api/pharma/products", (req) => inTenant(req, (tx) => tx.query(
    `SELECT p.id, p.sku, p.name, pp.kind, pp.legal_category, pp.cd_schedule, pp.storage, pp.batch_tracked, pp.licence_number, pp.device_mark,
            coalesce((SELECT sum(on_hand) FROM pharma_batches b WHERE b.product_id = p.id AND b.status = 'released'), 0) AS released,
            coalesce((SELECT sum(on_hand) FROM pharma_batches b WHERE b.product_id = p.id AND b.status = 'quarantine'), 0) AS quarantine
       FROM products p LEFT JOIN pharma_products pp ON pp.product_id = p.id WHERE NOT p.archived ORDER BY p.sku`)));

  app.put("/api/pharma/products/:id", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const input = ProductInput.parse(req.body);
    const [p] = await tx.query("SELECT 1 FROM products WHERE id = $1", [id]);
    if (!p) throw notFound("Product");
    if (input.kind === "medicine" && !input.legalCategory) throw unprocessable("Choose the medicine's legal category (POM, P or GSL)");
    const [existing] = await tx.query<{ batch_tracked: boolean }>("SELECT batch_tracked FROM pharma_products WHERE product_id = $1", [id]);
    if (existing?.batch_tracked && !input.batchTracked) throw unprocessable("Batch tracking cannot be switched off once on");
    if (!existing?.batch_tracked && input.batchTracked) {
      const [stock] = await tx.query("SELECT 1 FROM stock_balances WHERE product_id = $1 AND quantity > 0", [id]);
      if (stock) throw unprocessable("Batch tracking can only be switched on while the product has no stock");
    }
    await tx.query(
      `INSERT INTO pharma_products (product_id, tenant_id, kind, legal_category, cd_schedule, storage, batch_tracked, licence_number, device_mark)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (product_id) DO UPDATE SET kind = EXCLUDED.kind, legal_category = EXCLUDED.legal_category,
         cd_schedule = EXCLUDED.cd_schedule, storage = EXCLUDED.storage, batch_tracked = EXCLUDED.batch_tracked,
         licence_number = EXCLUDED.licence_number, device_mark = EXCLUDED.device_mark`,
      [id, ctx.tenantId, input.kind, input.kind === "medicine" ? input.legalCategory : null,
        input.kind === "medicine" ? input.cdSchedule ?? null : null, input.storage, input.batchTracked,
        input.licenceNumber ?? null, input.kind === "device" ? input.deviceMark ?? null : null]);
    await audit(tx, ctx, "pharma_product.classified", "product", id, input);
    return { ok: true };
  }));

  // ---------------------------------------------------------------- responsible persons
  app.get("/api/pharma/responsible-persons", (req) => inTenant(req, (tx) => tx.query(
    `SELECT rp.*, u.name, u.email FROM pharma_responsible_persons rp JOIN users u ON u.id = rp.user_id ORDER BY rp.active DESC, u.name`)));

  app.get("/api/pharma/users", (req) => inTenant(req, (tx) => tx.query(
    "SELECT u.id, u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id ORDER BY u.name")));

  app.post("/api/pharma/responsible-persons", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "settings");
    const input = z.object({ userId: uuid, appointedOn: isoDate }).parse(req.body);
    const [m] = await tx.query("SELECT 1 FROM memberships WHERE user_id = $1", [input.userId]);
    if (!m) throw unprocessable("That user is not a member of this company");
    const id = newId();
    await tx.query(
      `INSERT INTO pharma_responsible_persons (id, tenant_id, user_id, appointed_on, created_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET active = true, appointed_on = EXCLUDED.appointed_on`,
      [id, ctx.tenantId, input.userId, input.appointedOn, ctx.userId]);
    await audit(tx, ctx, "pharma_rp.appointed", "user", input.userId, input);
    return reply.status(201).send({ ok: true });
  }));

  app.post("/api/pharma/responsible-persons/:id/stand-down", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "settings");
    const { id } = IdParams.parse(req.params);
    const rows = await tx.query<{ user_id: string }>("UPDATE pharma_responsible_persons SET active = false WHERE id = $1 RETURNING user_id", [id]);
    if (!rows.length) throw notFound("Responsible Person");
    await audit(tx, ctx, "pharma_rp.stood_down", "user", rows[0]!.user_id);
    return { ok: true };
  }));

  // ---------------------------------------------------------------- customer licences
  app.get("/api/pharma/licences", (req) => inTenant(req, async (tx) => {
    const rows = await tx.query<Record<string, unknown> & { type: LicenceType; number: string; valid_from: string | null;
      expires_on: string | null; verified_on: string | null; status: "active" | "suspended" }>(
      `SELECT l.*, c.name AS customer_name, coalesce(cp.min_shelf_life_days, 0) AS min_shelf_life_days
         FROM pharma_customer_licences l JOIN contacts c ON c.id = l.contact_id
         LEFT JOIN pharma_customer_profiles cp ON cp.contact_id = l.contact_id ORDER BY c.name, l.type`);
    const on = today();
    return rows.map((r) => ({ ...r, label: LICENCE_TYPES[r.type], problem: licenceProblem({ type: r.type, number: r.number,
      validFrom: r.valid_from, expiresOn: r.expires_on, verifiedOn: r.verified_on, status: r.status }, { onDate: on }) }));
  }));

  app.get("/api/pharma/customers/:id", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const [c] = await tx.query("SELECT id, name, kind FROM contacts WHERE id = $1", [id]);
    if (!c) throw notFound("Customer");
    const licences = await customerLicences(tx, id);
    const on = today();
    return { ...c, minShelfLifeDays: await minShelfLife(tx, id),
      licences: licences.map((l) => ({ ...l, label: LICENCE_TYPES[l.type], problem: licenceProblem(l, { onDate: on }) })) };
  }));

  app.put("/api/pharma/customers/:id/profile", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const { minShelfLifeDays } = z.object({ minShelfLifeDays: z.number().int().min(0).max(1095) }).parse(req.body);
    await tx.query(
      `INSERT INTO pharma_customer_profiles (contact_id, tenant_id, min_shelf_life_days) VALUES ($1,$2,$3)
       ON CONFLICT (contact_id) DO UPDATE SET min_shelf_life_days = EXCLUDED.min_shelf_life_days`, [id, ctx.tenantId, minShelfLifeDays]);
    await audit(tx, ctx, "pharma_customer.profile", "contact", id, { minShelfLifeDays });
    return { ok: true };
  }));

  app.post("/api/pharma/customers/:id/licences", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const input = LicenceInput.parse(req.body);
    const [c] = await tx.query<{ kind: string }>("SELECT kind FROM contacts WHERE id = $1", [id]);
    if (!c || c.kind === "supplier") throw unprocessable("Customer not found");
    if (input.verifiedOn && !input.verificationSource) throw unprocessable("Say where the licence was verified (e.g. the GPhC register)");
    const licenceId = newId();
    await tx.query(
      `INSERT INTO pharma_customer_licences (id, tenant_id, contact_id, type, number, valid_from, expires_on, verified_on, verified_by, verification_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [licenceId, ctx.tenantId, id, input.type, input.number, input.validFrom ?? null, input.expiresOn ?? null,
        input.verifiedOn ?? null, input.verifiedOn ? ctx.userId : null, input.verificationSource ?? null]);
    await audit(tx, ctx, "pharma_licence.added", "contact", id, input);
    return reply.status(201).send({ id: licenceId });
  }));

  app.post("/api/pharma/licences/:id/verify", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const input = VerifyInput.parse(req.body);
    const rows = await tx.query<{ contact_id: string }>(
      "UPDATE pharma_customer_licences SET verified_on = $2, verified_by = $3, verification_source = $4 WHERE id = $1 RETURNING contact_id",
      [id, input.verifiedOn, ctx.userId, input.verificationSource]);
    if (!rows.length) throw notFound("Licence");
    await audit(tx, ctx, "pharma_licence.verified", "contact", rows[0]!.contact_id, { licence: id, ...input });
    return { ok: true };
  }));

  app.post("/api/pharma/licences/:id/:status", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id, status } = z.object({ id: uuid, status: z.enum(["suspend", "reinstate"]) }).parse(req.params);
    const rows = await tx.query<{ contact_id: string }>("UPDATE pharma_customer_licences SET status = $2 WHERE id = $1 RETURNING contact_id",
      [id, status === "suspend" ? "suspended" : "active"]);
    if (!rows.length) throw notFound("Licence");
    await audit(tx, ctx, `pharma_licence.${status}`, "contact", rows[0]!.contact_id, { licence: id });
    return { ok: true };
  }));

  // ---------------------------------------------------------------- goods in with batches
  app.post("/api/pharma/receipts", (req, reply) => inTenant(req, (tx, ctx) => rules(async () => {
    requireWrite(ctx, "operations");
    const input = ReceiptInput.parse(req.body);
    // Validate batch detail before anything is posted.
    const details: { tracked: boolean; batchNumber?: string; expiry?: string; manufacturedOn?: string }[] = [];
    for (const l of input.lines) {
      const [pl] = await tx.query<{ sku: string; batch_tracked: boolean | null }>(
        `SELECT p.sku, pp.batch_tracked FROM purchase_order_lines pl JOIN products p ON p.id = pl.product_id
           LEFT JOIN pharma_products pp ON pp.product_id = p.id WHERE pl.id = $1 AND pl.po_id = $2`, [l.poLineId, input.poId]);
      if (!pl) throw unprocessable("Purchase order line not found");
      if (!pl.batch_tracked) { details.push({ tracked: false }); continue; }
      if (!l.batchNumber || !l.expiry) throw unprocessable(`${pl.sku} is batch-tracked: enter its batch number and expiry`);
      const expiry = normaliseExpiry(l.expiry);
      if (expiry < input.date) throw unprocessable(`Batch ${l.batchNumber} of ${pl.sku} expired on ${expiry}; do not accept it into stock`);
      details.push({ tracked: true, batchNumber: l.batchNumber.toUpperCase(), expiry, manufacturedOn: l.manufacturedOn });
    }
    const grn = await receiveGoods(tx, ctx, input.poId, { date: input.date, rate: input.rate, lines: input.lines.map((l) => ({ poLineId: l.poLineId, quantity: l.quantity })) });
    const batches: { id: string; batchNumber: string }[] = [];
    for (const [i, line] of grn.lines.entries()) {
      const det = details[i]!;
      if (!det.tracked) continue;
      const batchId = newId();
      const eventId = newId();
      await tx.query(
        `INSERT INTO pharma_batches (id, tenant_id, product_id, warehouse_id, batch_number, expiry, manufactured_on, supplier_id,
           receipt_id, receipt_line_id, received_on, received_qty, status_event_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [batchId, ctx.tenantId, line.productId, grn.warehouseId, det.batchNumber, det.expiry, det.manufacturedOn ?? null,
          grn.supplierId, grn.id, line.id, input.date, line.quantity, eventId]);
      await tx.query(
        `INSERT INTO pharma_batch_events (id, tenant_id, batch_id, action, from_status, to_status, reason, decided_by)
         VALUES ($1,$2,$3,'receive',NULL,'quarantine',$4,$5)`, [eventId, ctx.tenantId, batchId, `Received on ${grn.number}`, ctx.userId]);
      await tx.query(
        `INSERT INTO pharma_batch_movements (id, tenant_id, batch_id, date, kind, quantity, source_type, source_id, created_by)
         VALUES ($1,$2,$3,$4,'receipt',$5,'goods_receipt',$6,$7)`, [newId(), ctx.tenantId, batchId, input.date, line.quantity, grn.id, ctx.userId]);
      batches.push({ id: batchId, batchNumber: det.batchNumber! });
    }
    await audit(tx, ctx, "pharma_receipt.posted", "goods_receipt", grn.id, { number: grn.number, batches: batches.map((b) => b.batchNumber) });
    return reply.status(201).send({ id: grn.id, number: grn.number, batches });
  })));

  // ---------------------------------------------------------------- batches & status
  app.get("/api/pharma/batches", (req) => inTenant(req, async (tx) => {
    const q = z.object({ status: z.string().optional(), productId: uuid.optional(), batchNumber: z.string().optional() }).parse(req.query);
    const rows = await tx.query<Record<string, unknown> & { expiry: string }>(
      `SELECT b.*, p.sku, p.name AS product_name, w.name AS warehouse_name, s.name AS supplier_name, r.number AS receipt_number
         FROM pharma_batches b JOIN products p ON p.id = b.product_id JOIN warehouses w ON w.id = b.warehouse_id
         JOIN contacts s ON s.id = b.supplier_id JOIN goods_receipts r ON r.id = b.receipt_id
        WHERE ($1::text IS NULL OR b.status = $1) AND ($2::uuid IS NULL OR b.product_id = $2)
          AND ($3::text IS NULL OR b.batch_number ILIKE '%' || $3 || '%')
        ORDER BY b.expiry, p.sku, b.batch_number`, [q.status || null, q.productId ?? null, q.batchNumber || null]);
    const on = today();
    return rows.map((r) => ({ ...r, band: expiryBand(r.expiry, on) }));
  }));

  app.get("/api/pharma/batches/:id", (req) => inTenant(req, async (tx, ctx) => {
    const { id } = IdParams.parse(req.params);
    const [b] = await tx.query<Record<string, unknown> & { status: BatchStatus; expiry: string }>(
      `SELECT b.*, p.sku, p.name AS product_name, w.name AS warehouse_name, s.name AS supplier_name, r.number AS receipt_number,
              po.number AS po_number
         FROM pharma_batches b JOIN products p ON p.id = b.product_id JOIN warehouses w ON w.id = b.warehouse_id
         JOIN contacts s ON s.id = b.supplier_id JOIN goods_receipts r ON r.id = b.receipt_id JOIN purchase_orders po ON po.id = r.po_id
        WHERE b.id = $1`, [id]);
    if (!b) throw notFound("Batch");
    const events = await tx.query(
      `SELECT e.*, u.name AS decided_by_name FROM pharma_batch_events e JOIN users u ON u.id = e.decided_by
        WHERE e.batch_id = $1 ORDER BY e.decided_at, e.action = 'receive' DESC`, [id]);
    const movements = await tx.query(
      `SELECT m.*, i.number AS invoice_number, c.name AS customer_name FROM pharma_batch_movements m
         LEFT JOIN pharma_dispatches dp ON m.source_type = 'dispatch' AND dp.id = m.source_id
         LEFT JOIN sales_invoices i ON i.id = dp.invoice_id LEFT JOIN contacts c ON c.id = dp.customer_id
        WHERE m.batch_id = $1 ORDER BY m.date, m.created_at`, [id]);
    return { ...b, band: expiryBand(b.expiry, today()), events, movements, actions: allowedActions(b.status),
      canDecide: await isResponsiblePerson(tx, ctx.userId) };
  }));

  app.post("/api/pharma/batches/:id/:action", (req) => inTenant(req, (tx, ctx) => rules(async () => {
    const { id, action } = z.object({ id: uuid, action: z.enum(["release", "reject", "quarantine", "recall"]) }).parse(req.params);
    const input = DecisionInput.parse(req.body ?? {});
    const [b] = await tx.query<{ status: BatchStatus; expiry: string; batch_number: string }>(
      "SELECT status, expiry, batch_number FROM pharma_batches WHERE id = $1 FOR UPDATE", [id]);
    if (!b) throw notFound("Batch");
    const to = await decide(tx, ctx, id, b, action, input);
    return { status: to };
  })));

  async function decide(tx: Sql, ctx: Ctx, batchId: string, b: { status: BatchStatus; expiry: string; batch_number: string },
    action: BatchAction, input: { reason?: string; reference?: string }) {
    const to = transitionBatch({ from: b.status, action, actorIsRp: await isResponsiblePerson(tx, ctx.userId),
      reason: input.reason, expiry: b.expiry, onDate: today() });
    await tx.query(
      `INSERT INTO pharma_batch_events (id, tenant_id, batch_id, action, from_status, to_status, reason, reference, decided_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [newId(), ctx.tenantId, batchId, action, b.status, to, input.reason ?? null, input.reference ?? null, ctx.userId]);
    await audit(tx, ctx, `pharma_batch.${action}`, "pharma_batch", batchId, { batch: b.batch_number, from: b.status, to, ...input });
    return to;
  }

  // ---------------------------------------------------------------- recall
  async function trace(tx: Sql, productId: string, batchNumber: string) {
    const [p] = await tx.query<{ sku: string; name: string }>("SELECT sku, name FROM products WHERE id = $1", [productId]);
    if (!p) throw notFound("Product");
    const lots = await tx.query<{ id: string; on_hand: string; received_qty: string }>(
      `SELECT b.id, b.batch_number, b.expiry, b.status, b.received_on, b.received_qty, b.on_hand, w.name AS warehouse_name,
              s.name AS supplier_name, r.number AS receipt_number, po.number AS po_number
         FROM pharma_batches b JOIN warehouses w ON w.id = b.warehouse_id JOIN contacts s ON s.id = b.supplier_id
         JOIN goods_receipts r ON r.id = b.receipt_id JOIN purchase_orders po ON po.id = r.po_id
        WHERE b.product_id = $1 AND upper(b.batch_number) = upper($2) ORDER BY b.received_on`, [productId, batchNumber]);
    const supplies = await tx.query<{ quantity: string }>(
      `SELECT dp.date, c.id AS customer_id, c.name AS customer_name, c.email AS customer_email, i.id AS invoice_id, i.number AS invoice_number,
              -sum(m.quantity) AS quantity
         FROM pharma_batch_movements m JOIN pharma_dispatches dp ON m.source_type = 'dispatch' AND dp.id = m.source_id
         JOIN sales_invoices i ON i.id = dp.invoice_id JOIN contacts c ON c.id = dp.customer_id
        WHERE m.batch_id = ANY($1::uuid[]) GROUP BY dp.date, c.id, c.name, c.email, i.id, i.number ORDER BY dp.date, i.number`,
      [lots.map((l) => l.id)]);
    return {
      product: { id: productId, ...p }, batchNumber: batchNumber.toUpperCase(), lots, supplies,
      received: toFixed(sum(lots.map((l) => l.received_qty)), 4),
      supplied: toFixed(sum(supplies.map((s) => s.quantity)), 4),
      onHand: toFixed(sum(lots.map((l) => l.on_hand)), 4),
      customers: new Set(supplies.map((s) => (s as unknown as { customer_id: string }).customer_id)).size,
    };
  }

  app.get("/api/pharma/trace", (req) => inTenant(req, async (tx) => {
    const q = z.object({ productId: uuid, batchNumber: z.string().trim().min(1) }).parse(req.query);
    return trace(tx, q.productId, q.batchNumber);
  }));

  app.post("/api/pharma/recalls", (req) => inTenant(req, (tx, ctx) => rules(async () => {
    const input = RecallInput.parse(req.body);
    const lots = await tx.query<{ id: string; status: BatchStatus; expiry: string; batch_number: string }>(
      "SELECT id, status, expiry, batch_number FROM pharma_batches WHERE product_id = $1 AND upper(batch_number) = upper($2) FOR UPDATE",
      [input.productId, input.batchNumber]);
    if (!lots.length) throw unprocessable(`No batch ${input.batchNumber} of that product has been received`);
    for (const lot of lots.filter((l) => l.status !== "recalled")) {
      await decide(tx, ctx, lot.id, lot, "recall", { reason: input.reason, reference: input.reference });
    }
    return trace(tx, input.productId, input.batchNumber);
  })));

  // ---------------------------------------------------------------- supply
  app.post("/api/pharma/allocation-preview", (req) => inTenant(req, async (tx) => {
    const input = PreviewInput.parse(req.body);
    const warehouseId = await warehouseFor(tx, input.warehouseId);
    const result = await planSupply(tx, input.customerId, input.date, warehouseId, input.lines, false);
    return {
      ...result,
      ok: result.plan.every((l) => !l.error),
      plan: result.plan.map((l) => ({ ...l, allocations: l.allocations.map((a) => ({ ...a, quantity: a.quantity.toString() })) })),
    };
  }));

  app.get("/api/pharma/dispatches", (req) => inTenant(req, (tx) => tx.query(
    `SELECT dp.id, dp.date, dp.invoice_id, i.number AS invoice_number, i.total, i.currency, c.name AS customer_name,
            (SELECT -coalesce(sum(m.quantity), 0) FROM pharma_batch_movements m WHERE m.source_type = 'dispatch' AND m.source_id = dp.id) AS units
       FROM pharma_dispatches dp JOIN sales_invoices i ON i.id = dp.invoice_id JOIN contacts c ON c.id = dp.customer_id
      ORDER BY dp.date DESC, i.number DESC`)));

  app.post("/api/pharma/dispatches", (req, reply) => inTenant(req, (tx, ctx) => rules(async () => {
    requireWrite(ctx, "operations");
    const input = DispatchInput.parse(req.body);
    const warehouseId = await warehouseFor(tx, input.warehouseId);
    const supply = await planSupply(tx, input.customerId, input.date, warehouseId, input.lines, true);
    const problems = supply.plan.filter((l) => l.error).map((l) => l.error);
    if (problems.length) throw unprocessable(problems.join(". "));

    const invoice = await createSalesDocument(tx, ctx, "invoice", InvoiceInput.parse({
      customerId: input.customerId, date: input.date, warehouseId, customerRef: input.customerRef,
      currency: input.currency, rate: input.rate, lines: input.lines,
    }));
    const dispatchId = newId();
    await tx.query(
      `INSERT INTO pharma_dispatches (id, tenant_id, invoice_id, customer_id, date, licences, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [dispatchId, ctx.tenantId, invoice.id, input.customerId, input.date,
        JSON.stringify(supply.licences.map((l) => ({ type: l.type, number: l.number, verifiedOn: l.verifiedOn, expiresOn: l.expiresOn }))), ctx.userId]);
    for (const line of supply.plan) {
      for (const a of line.allocations) {
        await tx.query(
          `INSERT INTO pharma_batch_movements (id, tenant_id, batch_id, date, kind, quantity, source_type, source_id, created_by)
           VALUES ($1,$2,$3,$4,'dispatch',$5,'dispatch',$6,$7)`,
          [newId(), ctx.tenantId, a.batchId, input.date, a.quantity.neg().toString(), dispatchId, ctx.userId]);
      }
    }
    await audit(tx, ctx, "pharma_dispatch.posted", "sales_invoice", invoice.id, {
      number: invoice.number, batches: supply.plan.flatMap((l) => l.allocations.map((a) => `${l.sku}/${a.batchNumber}×${a.quantity}`)),
    });
    return reply.status(201).send({ id: dispatchId, invoiceId: invoice.id, invoiceNumber: invoice.number,
      allocations: supply.plan.map((l) => ({ sku: l.sku, batches: l.allocations.map((a) => ({ ...a, quantity: a.quantity.toString() })) })) });
  })));

  // ---------------------------------------------------------------- integrity
  app.get("/api/pharma/integrity", (req) => inTenant(req, async (tx) => {
    const rows = await tx.query<{ sku: string; warehouse: string; batches: string; stock: string }>(
      `SELECT p.sku, w.name AS warehouse,
              coalesce((SELECT sum(on_hand) FROM pharma_batches b WHERE b.product_id = p.id AND b.warehouse_id = w.id), 0) AS batches,
              coalesce((SELECT quantity FROM stock_balances s WHERE s.product_id = p.id AND s.warehouse_id = w.id), 0) AS stock
         FROM pharma_products pp JOIN products p ON p.id = pp.product_id CROSS JOIN warehouses w
        WHERE pp.batch_tracked ORDER BY p.sku, w.name`);
    const [m] = await tx.query<{ movements: string; on_hand: string }>(
      `SELECT (SELECT coalesce(sum(quantity), 0) FROM pharma_batch_movements) AS movements,
              (SELECT coalesce(sum(on_hand), 0) FROM pharma_batches) AS on_hand`);
    const lines = rows.filter((r) => !d(r.batches).isZero() || !d(r.stock).isZero())
      .map((r) => ({ ...r, reconciled: d(r.batches).equals(r.stock) }));
    const projection = d(m!.movements).equals(m!.on_hand);
    return { lines, projection: { ...m, reconciled: projection }, allReconciled: projection && lines.every((l) => l.reconciled) };
  }));
}
