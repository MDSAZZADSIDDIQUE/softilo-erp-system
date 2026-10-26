import { inTenant, requireWrite, type Ctx } from "@softilo/api/lib/context";
import { notFound, unprocessable } from "@softilo/api/lib/errors";
import { audit, loadRoles, postJournal } from "@softilo/api/lib/ledger";
import { IdParams, isoDate, quantity, uuid } from "@softilo/api/lib/schemas";
import { position, stockIn, stockOut } from "@softilo/api/lib/stock";
import { newId, type Sql } from "@softilo/db";
import { d, issue, sum, toFixed, ZERO, type Dec, type RoleMap } from "@softilo/domain";
import {
  assertNoBomCycle, BomCycleError, completionCost, conversionCost, explodeRequirements, MFG_ACCOUNTS,
  postCompletion, postConversion, postMaterialIssue, rollUpCost, runMrp,
  type Bom, type BomMap, type MfgRoleMap, type WorkCentreRates,
} from "@softilo/mfg-domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

// ---------------------------------------------------------------- input schemas

const decimal = (places: number, label: string) => z.union([z.string(), z.number()]).transform(String)
  .refine((v) => new RegExp(`^\\d{1,12}(\\.\\d{1,${places}})?$`).test(v), `${label} must be a number with at most ${places} decimal places`);
const hours = decimal(4, "Hours").refine((v) => Number(v) > 0, "Hours must be greater than zero");
const rate = decimal(4, "Rate");
const nonNegQty = decimal(4, "Quantity");

const WorkCentre = z.object({
  code: z.string().trim().min(1).max(20).transform((s) => s.toUpperCase()),
  name: z.string().trim().min(1).max(100),
  labourRate: rate,
  overheadRate: rate,
});

const BomInput = z.object({
  productId: uuid,
  outputQty: quantity.default("1"),
  notes: z.string().max(2000).optional(),
  activate: z.boolean().default(true),
  lines: z.array(z.object({
    componentId: uuid,
    quantity,
    wastagePct: decimal(4, "Wastage").refine((v) => Number(v) < 1000, "Wastage must be under 1000%").default("0"),
  })).min(1, "A bill of materials needs at least one component"),
  operations: z.array(z.object({
    workCentreId: uuid,
    description: z.string().trim().min(1).max(200),
    setupHours: nonNegQty.default("0"),
    runHoursPerUnit: decimal(6, "Run hours").default("0"),
  })).default([]),
});

const WorksOrderInput = z.object({
  productId: uuid,
  quantity,
  warehouseId: uuid.optional(),
  dueDate: isoDate.optional(),
  notes: z.string().max(2000).optional(),
  release: z.boolean().default(false),
});

// ---------------------------------------------------------------- helpers

const PREFIX = { works_order: "WO" } as const;

/** Gap-free numbering, same counter table and scheme as the core documents. */
async function nextNumber(tx: Sql, ctx: Ctx, kind: keyof typeof PREFIX): Promise<string> {
  const [row] = await tx.query<{ value: string }>(
    `INSERT INTO number_sequences (tenant_id, kind, prefix, next_value) VALUES ($1, $2, $3, 2)
     ON CONFLICT (tenant_id, kind) DO UPDATE SET next_value = number_sequences.next_value + 1
     RETURNING next_value - 1 AS value`,
    [ctx.tenantId, kind, PREFIX[kind]],
  );
  return `${PREFIX[kind]}-${String(row!.value).padStart(5, "0")}`;
}

/** Add the manufacturing accounts to the tenant's chart if missing, and return both role maps. */
async function accounts(tx: Sql, ctx: Ctx): Promise<{ acc: RoleMap; mfg: MfgRoleMap }> {
  for (const a of MFG_ACCOUNTS) {
    await tx.query(
      `INSERT INTO accounts (tenant_id, code, name, type, role, is_control) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [ctx.tenantId, a.code, a.name, a.type, a.role, a.control ?? false],
    );
  }
  const roles = await loadRoles(tx) as Record<string, string>;
  for (const a of MFG_ACCOUNTS) {
    if (!roles[a.role]) throw unprocessable(`Account ${a.code} is already used for something else; manufacturing needs it for ${a.name}`);
  }
  return { acc: roles as RoleMap, mfg: Object.fromEntries(MFG_ACCOUNTS.map((a) => [a.role, roles[a.role]!])) as MfgRoleMap };
}

type BomRow = { id: string; product_id: string; output_qty: string };

async function bomFromRow(tx: Sql, b: BomRow): Promise<Bom> {
  const lines = await tx.query<{ component_id: string; quantity: string; wastage_pct: string }>(
    "SELECT component_id, quantity, wastage_pct FROM mfg_bom_lines WHERE bom_id = $1 ORDER BY line_no", [b.id]);
  const ops = await tx.query<{ work_centre_id: string; setup_hours: string; run_hours_per_unit: string }>(
    "SELECT work_centre_id, setup_hours, run_hours_per_unit FROM mfg_bom_operations WHERE bom_id = $1 ORDER BY seq", [b.id]);
  return {
    productId: b.product_id,
    outputQty: b.output_qty,
    lines: lines.map((l) => ({ componentId: l.component_id, quantity: l.quantity, wastagePct: l.wastage_pct })),
    operations: ops.map((o) => ({ workCentreId: o.work_centre_id, setupHours: o.setup_hours, runHoursPerUnit: o.run_hours_per_unit })),
  };
}

/** Active BOMs by product. `replace` swaps in a candidate BOM (for cycle checks and previews). */
async function activeBoms(tx: Sql, replace?: Bom): Promise<BomMap> {
  const rows = await tx.query<BomRow>("SELECT id, product_id, output_qty FROM mfg_boms WHERE is_active");
  const map: BomMap = new Map();
  for (const r of rows) map.set(r.product_id, await bomFromRow(tx, r));
  if (replace) map.set(replace.productId, replace);
  return map;
}

/** Refuse a cycle, naming it from `start` (the product being changed) so the message reads naturally. */
function checkCycles(boms: BomMap, skus: Map<string, string>, start: string) {
  try {
    assertNoBomCycle(boms);
  } catch (e) {
    if (e instanceof BomCycleError) {
      const ring = e.path.slice(0, -1);
      const i = Math.max(ring.indexOf(start), 0);
      const path = [...ring.slice(i), ...ring.slice(0, i), ring[i]!];
      throw unprocessable(`A bill of materials cannot contain itself: ${path.map((p) => skus.get(p) ?? p).join(" → ")}`);
    }
    throw e;
  }
}

async function skuMap(tx: Sql): Promise<Map<string, string>> {
  const rows = await tx.query<{ id: string; sku: string }>("SELECT id, sku FROM products");
  return new Map(rows.map((r) => [r.id, r.sku]));
}

async function workCentreRates(tx: Sql): Promise<Map<string, WorkCentreRates>> {
  const rows = await tx.query<{ id: string; labour_rate: string; overhead_rate: string }>(
    "SELECT id, labour_rate, overhead_rate FROM mfg_work_centres");
  return new Map(rows.map((r) => [r.id, { labourRate: r.labour_rate, overheadRate: r.overhead_rate }]));
}

/**
 * Cost of bought-in items for the roll-up: average cost of stock on hand across warehouses,
 * falling back to the last goods-receipt cost when none is in stock.
 */
async function boughtCosts(tx: Sql): Promise<Map<string, string>> {
  const rows = await tx.query<{ product_id: string; cost: string }>(
    `SELECT p.id AS product_id,
            coalesce(
              (SELECT round(sum(b.value) / nullif(sum(b.quantity), 0), 6) FROM stock_balances b WHERE b.product_id = p.id AND b.quantity > 0),
              (SELECT l.unit_cost_gbp FROM goods_receipt_lines l JOIN goods_receipts g ON g.id = l.receipt_id
                WHERE l.product_id = p.id ORDER BY g.date DESC, g.created_at DESC LIMIT 1)
            ) AS cost
       FROM products p`);
  return new Map(rows.filter((r) => r.cost !== null).map((r) => [r.product_id, r.cost]));
}

function rollupJson(r: ReturnType<typeof rollUpCost>, skus: Map<string, string>) {
  return {
    material: r.material.toFixed(6), labour: r.labour.toFixed(6), overhead: r.overhead.toFixed(6), total: r.total.toFixed(6),
    missingCosts: r.missingCosts.map((p) => skus.get(p) ?? p),
    components: r.components.map((c) => ({
      productId: c.productId, sku: skus.get(c.productId), made: c.made,
      quantityPerUnit: c.quantityPerUnit.toFixed(6), unitCost: c.unitCost.toFixed(6), extended: c.extended.toFixed(6),
    })),
  };
}

type WoRow = {
  id: string; number: string; product_id: string; warehouse_id: string; status: string;
  quantity: string; completed_qty: string; scrapped_qty: string;
};

async function lockOrder(tx: Sql, id: string, statuses: string[] = ["released"]): Promise<WoRow> {
  const [wo] = await tx.query<WoRow>("SELECT * FROM mfg_works_orders WHERE id = $1 FOR UPDATE", [id]);
  if (!wo) throw notFound("Works order");
  if (!statuses.includes(wo.status)) {
    throw unprocessable(`Works order ${wo.number} is ${wo.status}; this needs it to be ${statuses.join(" or ")}`);
  }
  return wo;
}

async function wipBalance(tx: Sql, woId: string): Promise<Dec> {
  const [r] = await tx.query<{ v: string }>("SELECT coalesce(sum(value), 0) AS v FROM mfg_wo_transactions WHERE works_order_id = $1", [woId]);
  return d(r!.v);
}

interface Txn {
  kind: "issue" | "labour" | "overhead" | "complete" | "scrap" | "variance";
  productId?: string; workCentreId?: string; quantity?: Dec | string; hours?: string; value: Dec;
}

async function writeTxns(tx: Sql, ctx: Ctx, wo: WoRow, date: string, entryId: string | null, txns: Txn[]) {
  for (const t of txns) {
    await tx.query(
      `INSERT INTO mfg_wo_transactions (id, tenant_id, works_order_id, date, kind, product_id, work_centre_id, quantity, hours, value, entry_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [newId(), ctx.tenantId, wo.id, date, t.kind, t.productId ?? null, t.workCentreId ?? null,
        t.quantity === undefined ? null : toFixed(t.quantity, 4), t.hours ?? null, toFixed(t.value), entryId, ctx.userId],
    );
  }
}

// ---------------------------------------------------------------- routes

export async function registerManufacturing(app: FastifyInstance) {
  // ---------------------------------------------------------------- work centres
  app.get("/api/mfg/work-centres", (req) => inTenant(req, (tx) =>
    tx.query("SELECT * FROM mfg_work_centres WHERE NOT archived ORDER BY code")));

  app.post("/api/mfg/work-centres", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const w = WorkCentre.parse(req.body);
    const id = newId();
    await tx.query(
      "INSERT INTO mfg_work_centres (id, tenant_id, code, name, labour_rate, overhead_rate) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, ctx.tenantId, w.code, w.name, w.labourRate, w.overheadRate]);
    await audit(tx, ctx, "work_centre.created", "work_centre", id, w);
    return reply.status(201).send({ id });
  }));

  app.patch("/api/mfg/work-centres/:id", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const w = WorkCentre.omit({ code: true }).partial().extend({ archived: z.boolean().optional() }).parse(req.body);
    const rows = await tx.query(
      `UPDATE mfg_work_centres SET name = coalesce($2, name), labour_rate = coalesce($3::numeric, labour_rate),
         overhead_rate = coalesce($4::numeric, overhead_rate), archived = coalesce($5, archived) WHERE id = $1 RETURNING id`,
      [id, w.name ?? null, w.labourRate ?? null, w.overheadRate ?? null, w.archived ?? null]);
    if (!rows.length) throw notFound("Work centre");
    await audit(tx, ctx, "work_centre.updated", "work_centre", id, w);
    return { ok: true };
  }));

  // ---------------------------------------------------------------- bills of materials
  app.get("/api/mfg/boms", (req) => inTenant(req, (tx) => tx.query(
    `SELECT b.id, b.product_id, b.version, b.output_qty, b.is_active, b.created_at, p.sku, p.name,
            (SELECT count(*) FROM mfg_bom_lines l WHERE l.bom_id = b.id) AS line_count,
            (SELECT count(*) FROM mfg_bom_operations o WHERE o.bom_id = b.id) AS operation_count
       FROM mfg_boms b JOIN products p ON p.id = b.product_id
      ORDER BY p.sku, b.version DESC`)));

  app.get("/api/mfg/boms/:id", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const [b] = await tx.query<BomRow & Record<string, unknown>>(
      `SELECT b.*, p.sku, p.name FROM mfg_boms b JOIN products p ON p.id = b.product_id WHERE b.id = $1`, [id]);
    if (!b) throw notFound("Bill of materials");
    const lines = await tx.query(
      `SELECT l.line_no, l.component_id, l.quantity, l.wastage_pct, p.sku, p.name, p.uom,
              EXISTS (SELECT 1 FROM mfg_boms s WHERE s.product_id = l.component_id AND s.is_active) AS made
         FROM mfg_bom_lines l JOIN products p ON p.id = l.component_id WHERE l.bom_id = $1 ORDER BY l.line_no`, [id]);
    const operations = await tx.query(
      `SELECT o.seq, o.description, o.setup_hours, o.run_hours_per_unit, w.id AS work_centre_id, w.code, w.name,
              w.labour_rate, w.overhead_rate
         FROM mfg_bom_operations o JOIN mfg_work_centres w ON w.id = o.work_centre_id WHERE o.bom_id = $1 ORDER BY o.seq`, [id]);
    const skus = await skuMap(tx);
    const boms = await activeBoms(tx, await bomFromRow(tx, b));
    const rollup = rollupJson(rollUpCost(b.product_id, boms, await boughtCosts(tx), await workCentreRates(tx)), skus);
    return { ...b, lines, operations, rollup };
  }));

  app.post("/api/mfg/boms", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const input = BomInput.parse(req.body);
    const [product] = await tx.query("SELECT id FROM products WHERE id = $1 AND NOT archived", [input.productId]);
    if (!product) throw notFound("Product");
    const ids = [...new Set(input.lines.map((l) => l.componentId))];
    const found = await tx.query("SELECT id FROM products WHERE id = ANY($1::uuid[]) AND NOT archived", [ids]);
    if (found.length !== ids.length) throw unprocessable("Every component must be an existing product");
    if (ids.includes(input.productId)) throw unprocessable("A product cannot be a component of itself");
    const centres = [...new Set(input.operations.map((o) => o.workCentreId))];
    const wc = await tx.query("SELECT id FROM mfg_work_centres WHERE id = ANY($1::uuid[]) AND NOT archived", [centres]);
    if (wc.length !== centres.length) throw unprocessable("Every operation needs an existing work centre");
    const candidate: Bom = {
      productId: input.productId, outputQty: input.outputQty,
      lines: input.lines.map((l) => ({ componentId: l.componentId, quantity: l.quantity, wastagePct: l.wastagePct })),
    };
    // A new version must not create a cycle with the BOMs it will sit beside once active.
    if (input.activate) checkCycles(await activeBoms(tx, candidate), await skuMap(tx), input.productId);

    const [v] = await tx.query<{ n: string }>("SELECT coalesce(max(version), 0) + 1 AS n FROM mfg_boms WHERE product_id = $1", [input.productId]);
    const id = newId();
    if (input.activate) await tx.query("UPDATE mfg_boms SET is_active = false WHERE product_id = $1 AND is_active", [input.productId]);
    await tx.query(
      `INSERT INTO mfg_boms (id, tenant_id, product_id, version, output_qty, is_active, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, ctx.tenantId, input.productId, Number(v!.n), input.outputQty, input.activate, input.notes ?? null, ctx.userId]);
    let n = 1;
    for (const l of input.lines) {
      await tx.query(
        `INSERT INTO mfg_bom_lines (id, tenant_id, bom_id, line_no, component_id, quantity, wastage_pct) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [newId(), ctx.tenantId, id, n++, l.componentId, l.quantity, l.wastagePct]);
    }
    n = 1;
    for (const o of input.operations) {
      await tx.query(
        `INSERT INTO mfg_bom_operations (id, tenant_id, bom_id, seq, work_centre_id, description, setup_hours, run_hours_per_unit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [newId(), ctx.tenantId, id, n++ * 10, o.workCentreId, o.description, o.setupHours, o.runHoursPerUnit]);
    }
    await audit(tx, ctx, "bom.created", "bom", id, input);
    return reply.status(201).send({ id, version: Number(v!.n) });
  }));

  app.post("/api/mfg/boms/:id/activate", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const [b] = await tx.query<BomRow>("SELECT id, product_id, output_qty FROM mfg_boms WHERE id = $1", [id]);
    if (!b) throw notFound("Bill of materials");
    checkCycles(await activeBoms(tx, await bomFromRow(tx, b)), await skuMap(tx), b.product_id);
    await tx.query("UPDATE mfg_boms SET is_active = (id = $1) WHERE product_id = $2", [id, b.product_id]);
    await audit(tx, ctx, "bom.activated", "bom", id);
    return { ok: true };
  }));

  /** Standard cost per unit for every product with an active BOM, against the average cost of stock held. */
  app.get("/api/mfg/cost-rollup", (req) => inTenant(req, async (tx) => {
    const boms = await activeBoms(tx);
    const skus = await skuMap(tx);
    const bought = await boughtCosts(tx);
    const rates = await workCentreRates(tx);
    const products = await tx.query<{ id: string; sku: string; name: string; on_hand: string; average_cost: string | null }>(
      `SELECT p.id, p.sku, p.name, coalesce(sum(b.quantity), 0) AS on_hand,
              CASE WHEN sum(b.quantity) > 0 THEN round(sum(b.value) / sum(b.quantity), 6) END AS average_cost
         FROM products p LEFT JOIN stock_balances b ON b.product_id = p.id
        WHERE p.id = ANY($1::uuid[]) GROUP BY p.id ORDER BY p.sku`, [[...boms.keys()]]);
    return products.map((p) => ({ ...p, ...rollupJson(rollUpCost(p.id, boms, bought, rates), skus) }));
  }));

  // ---------------------------------------------------------------- works orders
  app.get("/api/mfg/works-orders", (req) => inTenant(req, async (tx) => {
    const q = z.object({ status: z.enum(["planned", "released", "completed", "cancelled", "open"]).optional() }).parse(req.query);
    return tx.query(
      `SELECT w.id, w.number, w.status, w.quantity, w.completed_qty, w.scrapped_qty, w.due_date, w.created_at,
              p.sku, p.name, h.code AS warehouse,
              coalesce((SELECT sum(value) FROM mfg_wo_transactions t WHERE t.works_order_id = w.id), 0) AS wip
         FROM mfg_works_orders w JOIN products p ON p.id = w.product_id JOIN warehouses h ON h.id = w.warehouse_id
        WHERE $1::text IS NULL OR w.status = $1 OR ($1 = 'open' AND w.status IN ('planned','released'))
        ORDER BY w.number DESC`, [q.status ?? null]);
  }));

  app.get("/api/mfg/works-orders/:id", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const [wo] = await tx.query<WoRow & Record<string, unknown>>(
      `SELECT w.*, p.sku, p.name, p.uom, h.code AS warehouse, b.version AS bom_version
         FROM mfg_works_orders w JOIN products p ON p.id = w.product_id JOIN warehouses h ON h.id = w.warehouse_id
         JOIN mfg_boms b ON b.id = w.bom_id WHERE w.id = $1`, [id]);
    if (!wo) throw notFound("Works order");
    const components = await tx.query(
      `SELECT c.product_id, c.required_qty, c.issued_qty, greatest(c.required_qty - c.issued_qty, 0) AS outstanding,
              p.sku, p.name, p.uom, p.track_stock, coalesce(b.quantity, 0) AS on_hand
         FROM mfg_works_order_components c JOIN products p ON p.id = c.product_id
         LEFT JOIN stock_balances b ON b.product_id = c.product_id AND b.warehouse_id = $2
        WHERE c.works_order_id = $1 ORDER BY p.sku`, [id, wo.warehouse_id]);
    const transactions = await tx.query(
      `SELECT t.date, t.kind, t.quantity, t.hours, t.value, t.created_at, p.sku, w.code AS work_centre, e.id AS entry_id, e.number AS journal
         FROM mfg_wo_transactions t LEFT JOIN products p ON p.id = t.product_id
         LEFT JOIN mfg_work_centres w ON w.id = t.work_centre_id LEFT JOIN journal_entries e ON e.id = t.entry_id
        WHERE t.works_order_id = $1 ORDER BY t.created_at, t.kind`, [id]);
    const operations = await tx.query(
      `SELECT o.seq, o.description, o.setup_hours, o.run_hours_per_unit, w.id AS work_centre_id, w.code, w.name
         FROM mfg_bom_operations o JOIN mfg_work_centres w ON w.id = o.work_centre_id WHERE o.bom_id = $1 ORDER BY o.seq`, [wo.bom_id]);
    const [totals] = await tx.query<{ wip: string; completed_value: string }>(
      `SELECT coalesce(sum(value), 0) AS wip, coalesce(-sum(value) FILTER (WHERE kind = 'complete'), 0) AS completed_value
         FROM mfg_wo_transactions WHERE works_order_id = $1`, [id]);
    const completed = d(wo.completed_qty);
    return {
      ...wo, components, transactions, operations,
      wip: totals!.wip,
      completedValue: totals!.completed_value,
      actualUnitCost: completed.greaterThan(0) ? d(totals!.completed_value).dividedBy(completed).toFixed(6) : null,
    };
  }));

  app.post("/api/mfg/works-orders", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const input = WorksOrderInput.parse(req.body);
    const [b] = await tx.query<BomRow>("SELECT id, product_id, output_qty FROM mfg_boms WHERE product_id = $1 AND is_active", [input.productId]);
    if (!b) throw unprocessable("This product has no active bill of materials");
    const [wh] = input.warehouseId
      ? await tx.query<{ id: string }>("SELECT id FROM warehouses WHERE id = $1", [input.warehouseId])
      : await tx.query<{ id: string }>("SELECT id FROM warehouses ORDER BY code LIMIT 1");
    if (!wh) throw notFound("Warehouse");
    const id = newId();
    const number = await nextNumber(tx, ctx, "works_order");
    const status = input.release ? "released" : "planned";
    await tx.query(
      `INSERT INTO mfg_works_orders (id, tenant_id, number, product_id, bom_id, warehouse_id, quantity, status, due_date, notes, created_by, released_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, ctx.tenantId, number, input.productId, b.id, wh.id, input.quantity, status, input.dueDate ?? null,
        input.notes ?? null, ctx.userId, input.release ? new Date().toISOString() : null]);
    for (const r of explodeRequirements(await bomFromRow(tx, b), input.quantity)) {
      await tx.query(
        "INSERT INTO mfg_works_order_components (id, tenant_id, works_order_id, product_id, required_qty) VALUES ($1,$2,$3,$4,$5)",
        [newId(), ctx.tenantId, id, r.productId, toFixed(r.quantity, 4)]);
    }
    await audit(tx, ctx, "works_order.created", "works_order", id, { number, ...input });
    return reply.status(201).send({ id, number });
  }));

  app.post("/api/mfg/works-orders/:id/release", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const wo = await lockOrder(tx, id, ["planned"]);
    await tx.query("UPDATE mfg_works_orders SET status = 'released', released_at = now() WHERE id = $1", [id]);
    await audit(tx, ctx, "works_order.released", "works_order", id, { number: wo.number });
    return { ok: true };
  }));

  app.post("/api/mfg/works-orders/:id/cancel", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const wo = await lockOrder(tx, id, ["planned", "released"]);
    const [t] = await tx.query("SELECT 1 FROM mfg_wo_transactions WHERE works_order_id = $1 LIMIT 1", [id]);
    if (t) throw unprocessable("This order has postings; complete or close it instead of cancelling");
    await tx.query("UPDATE mfg_works_orders SET status = 'cancelled' WHERE id = $1", [id]);
    await audit(tx, ctx, "works_order.cancelled", "works_order", id, { number: wo.number });
    return { ok: true };
  }));

  /** Issue components at weighted-average cost: Dr WIP, Cr Stock. With no lines, issues everything outstanding. */
  app.post("/api/mfg/works-orders/:id/issue", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const body = z.object({
      date: isoDate,
      lines: z.array(z.object({ productId: uuid, quantity })).optional(),
    }).parse(req.body);
    const wo = await lockOrder(tx, id);
    const comps = await tx.query<{ product_id: string; required_qty: string; issued_qty: string; sku: string; track_stock: boolean }>(
      `SELECT c.product_id, c.required_qty, c.issued_qty, p.sku, p.track_stock
         FROM mfg_works_order_components c JOIN products p ON p.id = c.product_id WHERE c.works_order_id = $1`, [id]);
    const byId = new Map(comps.map((c) => [c.product_id, c]));
    const lines = body.lines
      ? body.lines.map((l) => {
        if (!byId.has(l.productId)) throw unprocessable("Only components on this works order can be issued to it");
        return { productId: l.productId, quantity: d(l.quantity) };
      })
      : comps.map((c) => ({ productId: c.product_id, quantity: d(c.required_qty).minus(c.issued_qty) }))
        .filter((l) => l.quantity.greaterThan(0));
    if (!lines.length) throw unprocessable("Nothing left to issue on this works order");
    if (new Set(lines.map((l) => l.productId)).size !== lines.length) throw unprocessable("List each component once");

    // Work out the cost first, so a zero-value issue posts no journal.
    const costs = new Map<string, Dec>();
    for (const l of lines) {
      if (!byId.get(l.productId)!.track_stock) { costs.set(l.productId, ZERO); continue; }
      costs.set(l.productId, issue(await position(tx, l.productId, wo.warehouse_id, true), l.quantity).cost);
    }
    const total = sum(costs.values());
    const entryId = total.isZero() ? null : newId();
    const txns: Txn[] = [];
    for (const l of lines) {
      if (byId.get(l.productId)!.track_stock) {
        await stockOut(tx, ctx, l.productId, wo.warehouse_id, l.quantity,
          { date: body.date, sourceType: "works_order", sourceId: wo.id, entryId: entryId ?? undefined });
      }
      await tx.query("UPDATE mfg_works_order_components SET issued_qty = issued_qty + $3 WHERE works_order_id = $1 AND product_id = $2",
        [id, l.productId, toFixed(l.quantity, 4)]);
      txns.push({ kind: "issue", productId: l.productId, quantity: l.quantity, value: costs.get(l.productId)! });
    }
    await writeTxns(tx, ctx, wo, body.date, entryId, txns);
    let journal: string | null = null;
    if (entryId) {
      const { acc, mfg } = await accounts(tx, ctx);
      const posting = postMaterialIssue(acc, mfg, {
        date: body.date, reference: wo.number,
        lines: lines.map((l) => ({ costGbp: costs.get(l.productId)!, description: byId.get(l.productId)!.sku })),
      });
      journal = (await postJournal(tx, ctx, posting, { type: "works_order", id: wo.id, entryId })).number;
    }
    await audit(tx, ctx, "works_order.issued", "works_order", id, { lines: lines.map((l) => ({ ...l, quantity: l.quantity.toString() })) });
    return { cost: total.toFixed(2), journal };
  }));

  /** Book time at a work centre: labour and overhead absorbed into WIP at the centre's standard rates. */
  app.post("/api/mfg/works-orders/:id/labour", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const body = z.object({ date: isoDate, workCentreId: uuid, hours }).parse(req.body);
    const wo = await lockOrder(tx, id);
    const [wc] = await tx.query<{ code: string; labour_rate: string; overhead_rate: string }>(
      "SELECT code, labour_rate, overhead_rate FROM mfg_work_centres WHERE id = $1 AND NOT archived", [body.workCentreId]);
    if (!wc) throw notFound("Work centre");
    const cost = conversionCost(body.hours, { labourRate: wc.labour_rate, overheadRate: wc.overhead_rate });
    const entryId = cost.labour.plus(cost.overhead).isZero() ? null : newId();
    await writeTxns(tx, ctx, wo, body.date, entryId, [
      { kind: "labour", workCentreId: body.workCentreId, hours: body.hours, value: cost.labour },
      { kind: "overhead", workCentreId: body.workCentreId, hours: body.hours, value: cost.overhead },
    ]);
    let journal: string | null = null;
    if (entryId) {
      const { mfg } = await accounts(tx, ctx);
      const posting = postConversion(mfg, {
        date: body.date, reference: wo.number, labourGbp: cost.labour, overheadGbp: cost.overhead,
        description: `${wc.code} ${body.hours} h`,
      });
      journal = (await postJournal(tx, ctx, posting, { type: "works_order", id: wo.id, entryId })).number;
    }
    await audit(tx, ctx, "works_order.time_booked", "works_order", id, body);
    return { labour: cost.labour.toFixed(2), overhead: cost.overhead.toFixed(2), journal };
  }));

  /**
   * Complete good units into stock at the order's actual WIP cost and write off abnormal scrap.
   * The final completion (or `close`) clears all WIP; a residual with no units goes to production variances.
   */
  app.post("/api/mfg/works-orders/:id/complete", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const body = z.object({
      date: isoDate,
      quantity: nonNegQty.default("0"),
      scrapQuantity: nonNegQty.default("0"),
      close: z.boolean().default(false),
    }).parse(req.body);
    const wo = await lockOrder(tx, id);
    const good = d(body.quantity);
    const scrap = d(body.scrapQuantity);
    const remaining = d(wo.quantity).minus(wo.completed_qty).minus(wo.scrapped_qty);
    const final = body.close || good.plus(scrap).greaterThanOrEqualTo(remaining);
    let cost;
    try {
      cost = completionCost({ wip: await wipBalance(tx, id), remaining, good, scrap, final });
    } catch (e) {
      throw unprocessable((e as Error).message);
    }
    const total = sum([cost.good, cost.scrap, cost.variance]);
    const entryId = total.isZero() ? null : newId();
    if (good.greaterThan(0)) {
      await stockIn(tx, ctx, wo.product_id, wo.warehouse_id, good, cost.good, "receipt",
        { date: body.date, sourceType: "works_order", sourceId: wo.id, entryId: entryId ?? undefined });
    }
    const txns: Txn[] = [];
    if (good.greaterThan(0)) txns.push({ kind: "complete", productId: wo.product_id, quantity: good, value: cost.good.neg() });
    if (scrap.greaterThan(0)) txns.push({ kind: "scrap", productId: wo.product_id, quantity: scrap, value: cost.scrap.neg() });
    if (!cost.variance.isZero()) txns.push({ kind: "variance", value: cost.variance.neg() });
    await writeTxns(tx, ctx, wo, body.date, entryId, txns);
    await tx.query(
      `UPDATE mfg_works_orders SET completed_qty = completed_qty + $2, scrapped_qty = scrapped_qty + $3,
         status = CASE WHEN $4 THEN 'completed' ELSE status END, completed_at = CASE WHEN $4 THEN now() ELSE completed_at END
       WHERE id = $1`, [id, toFixed(good, 4), toFixed(scrap, 4), final]);
    let journal: string | null = null;
    if (entryId) {
      const { acc, mfg } = await accounts(tx, ctx);
      const posting = postCompletion(acc, mfg, { date: body.date, reference: wo.number, cost });
      journal = (await postJournal(tx, ctx, posting, { type: "works_order", id: wo.id, entryId })).number;
    }
    await audit(tx, ctx, "works_order.completed", "works_order", id, { ...body, final });
    return {
      finishedGoods: cost.good.toFixed(2), scrap: cost.scrap.toFixed(2), variance: cost.variance.toFixed(2),
      wipAfter: cost.wipAfter.toFixed(2), closed: final, journal,
    };
  }));

  // ---------------------------------------------------------------- MRP
  /** Shortages against open works orders, stock on hand, open purchase orders and output still to come. */
  app.get("/api/mfg/mrp", (req) => inTenant(req, async (tx) => {
    const boms = await activeBoms(tx);
    const demand = await tx.query<{ product_id: string; qty: string }>(
      `SELECT c.product_id, sum(c.required_qty - c.issued_qty) AS qty
         FROM mfg_works_order_components c JOIN mfg_works_orders w ON w.id = c.works_order_id
        WHERE w.status IN ('planned','released') AND c.required_qty > c.issued_qty GROUP BY c.product_id`);
    const onHand = await tx.query<{ product_id: string; qty: string }>(
      "SELECT product_id, sum(quantity) AS qty FROM stock_balances GROUP BY product_id");
    const onOrder = await tx.query<{ product_id: string; qty: string }>(
      `SELECT l.product_id, sum(l.quantity - l.received_qty) AS qty
         FROM purchase_order_lines l JOIN purchase_orders o ON o.id = l.po_id
        WHERE o.status IN ('approved','part_received') AND l.quantity > l.received_qty GROUP BY l.product_id`);
    const inProduction = await tx.query<{ product_id: string; qty: string }>(
      `SELECT product_id, sum(greatest(quantity - completed_qty - scrapped_qty, 0)) AS qty
         FROM mfg_works_orders WHERE status IN ('planned','released') GROUP BY product_id`);
    const toMap = (rows: { product_id: string; qty: string }[]) => new Map(rows.map((r) => [r.product_id, r.qty]));
    const rows = runMrp({
      boms, demand: demand.map((r) => ({ productId: r.product_id, quantity: r.qty })),
      onHand: toMap(onHand), onOrder: toMap(onOrder), inProduction: toMap(inProduction),
    });
    const products = await tx.query<{ id: string; sku: string; name: string; uom: string }>(
      "SELECT id, sku, name, uom FROM products WHERE id = ANY($1::uuid[])", [rows.map((r) => r.productId)]);
    const info = new Map(products.map((p) => [p.id, p]));
    return rows.map((r) => ({
      productId: r.productId, sku: info.get(r.productId)?.sku, name: info.get(r.productId)?.name, uom: info.get(r.productId)?.uom,
      level: r.level, demand: r.demand.toFixed(4), onHand: r.onHand.toFixed(4), onOrder: r.onOrder.toFixed(4),
      inProduction: r.inProduction.toFixed(4), shortage: r.shortage.toFixed(4), action: r.action,
    }));
  }));

  // ---------------------------------------------------------------- integrity
  /** WIP sub-ledger (works-order transactions) vs. the WIP account; closed orders must hold no WIP. */
  app.get("/api/mfg/integrity", (req) => inTenant(req, async (tx) => {
    const [w] = await tx.query<{ orders: string; ledger: string }>(
      `SELECT (SELECT coalesce(sum(value), 0) FROM mfg_wo_transactions) AS orders,
              (SELECT coalesce(sum(debit - credit), 0) FROM journal_lines l JOIN accounts a ON a.code = l.account_code WHERE a.role = 'wip') AS ledger`);
    const [c] = await tx.query<{ n: string }>(
      `SELECT count(*) AS n FROM mfg_works_orders w
        WHERE w.status IN ('completed','cancelled')
          AND (SELECT coalesce(sum(value), 0) FROM mfg_wo_transactions t WHERE t.works_order_id = w.id) <> 0`);
    const wip = { orders: w!.orders, ledger: w!.ledger, reconciled: d(w!.orders).equals(w!.ledger) };
    const closedOrders = { withWip: Number(c!.n), reconciled: c!.n === "0" };
    return { wip, closedOrders, allReconciled: wip.reconciled && closedOrders.reconciled };
  }));
}
