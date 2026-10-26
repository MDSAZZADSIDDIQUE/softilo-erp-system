import { d, ZERO, type Dec, type DecInput } from "@softilo/domain";
import { lowLevelCodes, requiredQuantity, type BomMap } from "./bom.js";

export interface MrpInput {
  boms: BomMap;
  /** Unissued component requirements on open works orders. */
  demand: { productId: string; quantity: DecInput }[];
  onHand: Map<string, DecInput>;
  /** Open purchase-order quantity not yet received. */
  onOrder: Map<string, DecInput>;
  /** Output still to come from open works orders. */
  inProduction: Map<string, DecInput>;
}

export interface MrpRow {
  productId: string;
  level: number;
  /** Requirements from open works orders plus demand exploded from short sub-assemblies. */
  demand: Dec;
  onHand: Dec;
  onOrder: Dec;
  inProduction: Dec;
  shortage: Dec;
  /** Make it (it has a BOM) or buy it; null when nothing is short. */
  action: "make" | "buy" | null;
}

/**
 * Shortage report with level-by-level netting. Products are processed in low-level-code order;
 * when a sub-assembly is short, the shortfall is exploded through its BOM into demand for its
 * components, which are netted at the next level.
 */
export function runMrp(input: MrpInput): MrpRow[] {
  const demand = new Map<string, Dec>();
  for (const r of input.demand) demand.set(r.productId, (demand.get(r.productId) ?? ZERO).plus(r.quantity));
  const levels = lowLevelCodes(input.boms, demand.keys());
  const order = [...levels].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  const rows: MrpRow[] = [];
  for (const [productId, level] of order) {
    const gross = demand.get(productId) ?? ZERO;
    if (!gross.greaterThan(0)) continue;
    const onHand = d(input.onHand.get(productId) ?? 0);
    const onOrder = d(input.onOrder.get(productId) ?? 0);
    const inProduction = d(input.inProduction.get(productId) ?? 0);
    const net = gross.minus(onHand).minus(onOrder).minus(inProduction);
    const shortage = net.greaterThan(0) ? net : ZERO;
    const bom = input.boms.get(productId);
    let action: MrpRow["action"] = null;
    if (shortage.greaterThan(0)) {
      action = bom ? "make" : "buy";
      for (const l of bom?.lines ?? []) {
        demand.set(l.componentId, (demand.get(l.componentId) ?? ZERO).plus(requiredQuantity(shortage, bom!.outputQty, l)));
      }
    }
    rows.push({ productId, level, demand: gross, onHand, onOrder, inProduction, shortage, action });
  }
  return rows;
}
