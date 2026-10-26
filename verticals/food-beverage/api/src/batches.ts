import type { Ctx } from "@softilo/api/lib/context";
import { unprocessable } from "@softilo/api/lib/errors";
import { newId, type Sql } from "@softilo/db";
import { d, toFixed, type Dec } from "@softilo/domain";
import type { BatchMovementKind, BatchStock, DateType } from "@softilo/fnb-domain";

export interface FoodSettings {
  product_id: string;
  batch_tracked: boolean;
  date_type: DateType;
  shelf_life_days: number | null;
  storage: "ambient" | "chilled" | "frozen";
  allergens: string[];
}

/** Food settings for the given products, only for those that are batch-tracked. */
export async function trackedSettings(tx: Sql, productIds: string[]): Promise<Map<string, FoodSettings>> {
  if (!productIds.length) return new Map();
  const rows = await tx.query<FoodSettings & Record<string, unknown>>(
    "SELECT * FROM fnb_product_settings WHERE batch_tracked AND product_id = ANY($1::uuid[])", [productIds]);
  return new Map(rows.map((r) => [r.product_id, r]));
}

/** Batches of a product with stock in a warehouse; locked for the rest of the transaction when allocating. */
export async function batchStock(tx: Sql, productId: string, warehouseId: string, lock = false): Promise<BatchStock[]> {
  const rows = await tx.query<{ id: string; code: string; expiry: string | null; date_type: DateType; quantity: string; received_on: string }>(
    `SELECT b.id, b.code, b.expiry, b.date_type, bb.quantity, b.received_on
       FROM fnb_batch_balances bb JOIN fnb_batches b ON b.id = bb.batch_id
      WHERE b.product_id = $1 AND bb.warehouse_id = $2 AND bb.quantity > 0
      ${lock ? "FOR UPDATE OF bb" : ""}`,
    [productId, warehouseId]);
  return rows.map((r) => ({ id: r.id, code: r.code, expiry: r.expiry, dateType: r.date_type, available: r.quantity, receivedOn: r.received_on }));
}

export interface BatchMove {
  batchId: string;
  warehouseId: string;
  date: string;
  kind: BatchMovementKind;
  /** Signed: positive into stock, negative out. */
  quantity: Dec;
  sourceType: string;
  sourceId: string;
  sourceLineId?: string | null;
  contactId?: string | null;
}

/** Append a batch movement and update the balance projection. The balance check refuses overdrawing a batch. */
export async function moveBatch(tx: Sql, ctx: Ctx, m: BatchMove) {
  await tx.query(
    `INSERT INTO fnb_batch_movements (id, tenant_id, batch_id, warehouse_id, date, kind, quantity, source_type, source_id, source_line_id, contact_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [newId(), ctx.tenantId, m.batchId, m.warehouseId, m.date, m.kind, toFixed(m.quantity, 4), m.sourceType, m.sourceId,
      m.sourceLineId ?? null, m.contactId ?? null, ctx.userId]);
  // Update first: Postgres checks the CHECK constraint on the proposed row even when ON CONFLICT would update instead.
  const updated = await tx.query(
    "UPDATE fnb_batch_balances SET quantity = quantity + $3 WHERE batch_id = $1 AND warehouse_id = $2 RETURNING quantity",
    [m.batchId, m.warehouseId, toFixed(m.quantity, 4)]);
  if (!updated.length) {
    await tx.query("INSERT INTO fnb_batch_balances (tenant_id, batch_id, warehouse_id, quantity) VALUES ($1,$2,$3,$4)",
      [ctx.tenantId, m.batchId, m.warehouseId, toFixed(m.quantity, 4)]);
  }
}

/**
 * The batch with this code for the product, created on first receipt. A repeat delivery of the same supplier lot
 * joins the existing batch, but only if the date mark matches: one batch has one date.
 */
export async function findOrCreateBatch(tx: Sql, ctx: Ctx, b: {
  productId: string; code: string; expiry: string | null; dateType: DateType; supplierId: string | null; receiptId: string | null; date: string;
}): Promise<string> {
  const [existing] = await tx.query<{ id: string; expiry: string | null }>(
    "SELECT id, expiry FROM fnb_batches WHERE product_id = $1 AND code = $2", [b.productId, b.code]);
  if (existing) {
    if (existing.expiry !== b.expiry) {
      throw unprocessable(`Batch ${b.code} is already recorded with date ${existing.expiry ?? "none"}; one batch can only have one date`);
    }
    return existing.id;
  }
  const id = newId();
  await tx.query(
    `INSERT INTO fnb_batches (id, tenant_id, product_id, code, expiry, date_type, supplier_id, receipt_id, received_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, ctx.tenantId, b.productId, b.code, b.expiry, b.dateType, b.supplierId, b.receiptId, b.date]);
  return id;
}

export function qty(v: Dec): string {
  return d(v).toFixed(4).replace(/\.?0+$/, "");
}
