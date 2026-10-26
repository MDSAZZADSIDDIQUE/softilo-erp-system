import { d, Dec, round6, sum, ZERO, type DecInput } from "@softilo/domain";

/** One component line: `quantity` of the component per BOM batch (`outputQty` units of the parent). */
export interface BomLine {
  componentId: string;
  quantity: DecInput;
  /** Expected loss as a percentage of the quantity, e.g. 5 = 5%. */
  wastagePct?: DecInput;
}

/** A routing step: setup is once per batch, run time is per unit made. */
export interface BomOperation {
  workCentreId: string;
  setupHours: DecInput;
  runHoursPerUnit: DecInput;
}

export interface Bom {
  productId: string;
  outputQty: DecInput;
  lines: BomLine[];
  operations?: BomOperation[];
}

/** Active BOMs keyed by the product they make. */
export type BomMap = Map<string, Bom>;

/**
 * Component quantity needed to make `orderQty` of the parent:
 * orderQty ÷ outputQty × line quantity × (1 + wastage%), rounded up to 4 decimal places
 * so a works order never asks for less than it needs.
 */
export function requiredQuantity(orderQty: DecInput, outputQty: DecInput, line: Pick<BomLine, "quantity" | "wastagePct">): Dec {
  const out = d(outputQty);
  if (!out.greaterThan(0)) throw new Error("BOM output quantity must be positive");
  const wastage = d(line.wastagePct ?? 0).dividedBy(100).plus(1);
  return d(orderQty).dividedBy(out).times(line.quantity).times(wastage).toDecimalPlaces(4, Dec.ROUND_UP);
}

/** Requirements for a works order, merged by component (a BOM may list a component twice). */
export function explodeRequirements(bom: Bom, orderQty: DecInput): { productId: string; quantity: Dec }[] {
  const out = new Map<string, Dec>();
  for (const l of bom.lines) {
    out.set(l.componentId, (out.get(l.componentId) ?? ZERO).plus(requiredQuantity(orderQty, bom.outputQty, l)));
  }
  return [...out].map(([productId, quantity]) => ({ productId, quantity }));
}

export class BomCycleError extends Error {
  constructor(public path: string[]) {
    super(`A bill of materials cannot contain itself: ${path.join(" → ")}`);
  }
}

/** Returns the first cycle found (as a path of product ids), or null. */
export function findBomCycle(boms: BomMap): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (p: string): string[] | null => {
    const s = state.get(p);
    if (s === "done") return null;
    if (s === "visiting") return [...stack.slice(stack.indexOf(p)), p];
    state.set(p, "visiting");
    stack.push(p);
    for (const l of boms.get(p)?.lines ?? []) {
      const cycle = visit(l.componentId);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(p, "done");
    return null;
  };
  for (const p of boms.keys()) {
    const cycle = visit(p);
    if (cycle) return cycle;
  }
  return null;
}

export function assertNoBomCycle(boms: BomMap): void {
  const cycle = findBomCycle(boms);
  if (cycle) throw new BomCycleError(cycle);
}

/**
 * Low-level code per product: the deepest level at which it appears in any BOM (top level = 0).
 * MRP nets products in low-level-code order, so every parent's demand is known before its components.
 */
export function lowLevelCodes(boms: BomMap, roots: Iterable<string> = []): Map<string, number> {
  assertNoBomCycle(boms);
  const level = new Map<string, number>();
  const visit = (p: string, depth: number) => {
    const prev = level.get(p);
    if (prev !== undefined && prev >= depth) return;
    level.set(p, depth);
    for (const l of boms.get(p)?.lines ?? []) visit(l.componentId, depth + 1);
  };
  for (const p of [...boms.keys(), ...roots]) visit(p, 0);
  return level;
}

export interface WorkCentreRates {
  labourRate: DecInput;
  overheadRate: DecInput;
}

export interface RolledCost {
  productId: string;
  /** Per unit, 6 decimal places. */
  material: Dec;
  labour: Dec;
  overhead: Dec;
  total: Dec;
  /** Bought-in components with no cost available, anywhere below this product. */
  missingCosts: string[];
  components: {
    productId: string;
    quantityPerUnit: Dec;
    unitCost: Dec;
    extended: Dec;
    made: boolean;
  }[];
}

/**
 * Standard cost per unit, rolled up through every BOM level.
 *   material = Σ component unit cost × qty × (1 + wastage%) ÷ output
 *   labour   = Σ (setup ÷ output + run per unit) × labour rate (overhead likewise)
 * Made components use their own rolled-up total; bought-in ones use `boughtCost`.
 */
export function rollUpCost(
  productId: string,
  boms: BomMap,
  boughtCost: Map<string, DecInput>,
  rates: Map<string, WorkCentreRates>,
): RolledCost {
  assertNoBomCycle(boms);
  const memo = new Map<string, RolledCost>();
  const roll = (p: string): RolledCost => {
    const cached = memo.get(p);
    if (cached) return cached;
    const bom = boms.get(p);
    if (!bom) throw new Error(`Product ${p} has no active bill of materials`);
    const output = d(bom.outputQty);
    const missing = new Set<string>();
    const components = bom.lines.map((l) => {
      const perUnit = d(l.quantity).times(d(l.wastagePct ?? 0).dividedBy(100).plus(1)).dividedBy(output);
      let unitCost: Dec;
      const made = boms.has(l.componentId);
      if (made) {
        const sub = roll(l.componentId);
        sub.missingCosts.forEach((m) => missing.add(m));
        unitCost = sub.total;
      } else {
        const c = boughtCost.get(l.componentId);
        if (c === undefined) missing.add(l.componentId);
        unitCost = d(c ?? 0);
      }
      return { productId: l.componentId, quantityPerUnit: round6(perUnit), unitCost, extended: perUnit.times(unitCost), made };
    });
    let labour = ZERO;
    let overhead = ZERO;
    for (const op of bom.operations ?? []) {
      const r = rates.get(op.workCentreId);
      if (!r) throw new Error(`Work centre ${op.workCentreId} has no rates`);
      const hours = d(op.setupHours).dividedBy(output).plus(op.runHoursPerUnit);
      labour = labour.plus(hours.times(r.labourRate));
      overhead = overhead.plus(hours.times(r.overheadRate));
    }
    const material = sum(components.map((c) => c.extended));
    const result: RolledCost = {
      productId: p,
      material: round6(material),
      labour: round6(labour),
      overhead: round6(overhead),
      total: round6(material.plus(labour).plus(overhead)),
      missingCosts: [...missing],
      components: components.map((c) => ({ ...c, extended: round6(c.extended) })),
    };
    memo.set(p, result);
    return result;
  };
  return roll(productId);
}
