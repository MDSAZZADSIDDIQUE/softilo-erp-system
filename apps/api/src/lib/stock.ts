import { newId, type Sql } from "@softilo/db";
import { d, issue, receive, revalue, toFixed, type Dec, type DecInput, type StockPosition } from "@softilo/domain";
import type { Ctx } from "./context.js";

export async function position(tx: Sql, productId: string, warehouseId: string, lock = false): Promise<StockPosition> {
  const [row] = await tx.query<{ quantity: string; value: string }>(
    `SELECT quantity, value FROM stock_balances WHERE product_id = $1 AND warehouse_id = $2 ${lock ? "FOR UPDATE" : ""}`,
    [productId, warehouseId],
  );
  return { quantity: d(row?.quantity ?? 0), value: d(row?.value ?? 0) };
}

interface MovementSource {
  date: string;
  sourceType: string;
  sourceId: string;
  entryId?: string;
}

async function write(tx: Sql, ctx: Ctx, productId: string, warehouseId: string, kind: string,
  qty: Dec, value: Dec, next: StockPosition, src: MovementSource) {
  await tx.query(
    `INSERT INTO stock_movements (id, tenant_id, product_id, warehouse_id, date, kind, quantity, value, source_type, source_id, entry_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [newId(), ctx.tenantId, productId, warehouseId, src.date, kind, toFixed(qty, 4), toFixed(value), src.sourceType, src.sourceId, src.entryId ?? null],
  );
  await tx.query(
    `INSERT INTO stock_balances (tenant_id, product_id, warehouse_id, quantity, value) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id, product_id, warehouse_id) DO UPDATE SET quantity = EXCLUDED.quantity, value = EXCLUDED.value`,
    [ctx.tenantId, productId, warehouseId, toFixed(next.quantity, 4), toFixed(next.value)],
  );
}

export async function stockIn(tx: Sql, ctx: Ctx, productId: string, warehouseId: string,
  qty: DecInput, value: DecInput, kind: "receipt" | "return" | "adjustment", src: MovementSource) {
  const p = await position(tx, productId, warehouseId, true);
  const next = receive(p, qty, value);
  await write(tx, ctx, productId, warehouseId, kind, d(qty), d(value), next, src);
}

/** Issue at weighted-average cost; returns the cost in GBP. */
export async function stockOut(tx: Sql, ctx: Ctx, productId: string, warehouseId: string,
  qty: DecInput, src: MovementSource, kind: "issue" | "adjustment" = "issue"): Promise<Dec> {
  const p = await position(tx, productId, warehouseId, true);
  const { cost, position: next } = issue(p, qty);
  await write(tx, ctx, productId, warehouseId, kind, d(qty).neg(), cost.neg(), next, src);
  return cost;
}

export async function stockRevalue(tx: Sql, ctx: Ctx, productId: string, warehouseId: string,
  value: DecInput, src: MovementSource) {
  const p = await position(tx, productId, warehouseId, true);
  const next = revalue(p, value);
  await write(tx, ctx, productId, warehouseId, "landed_cost", d(0), d(value), next, src);
}

