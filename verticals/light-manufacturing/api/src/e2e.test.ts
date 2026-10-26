import { createPgliteDatabase, type Database } from "@softilo/db";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEdition, migrateEdition } from "./edition.js";

let db: Database;
let app: FastifyInstance;

/** A signed-in client: keeps the session cookie between calls. */
function client() {
  let cookie = "";
  const call = async (method: InjectOptions["method"], url: string, body?: unknown) => {
    const res = await app.inject({ method, url, payload: body as InjectOptions["payload"], headers: cookie ? { cookie } : {} });
    const set = res.headers["set-cookie"];
    if (set) cookie = (Array.isArray(set) ? set[0]! : set).split(";")[0]!;
    return { status: res.statusCode, body: res.body ? res.json() : undefined };
  };
  const ok = async (method: InjectOptions["method"], url: string, body?: unknown) => {
    const r = await call(method, url, body);
    if (r.status >= 400) throw new Error(`${method} ${url} → ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  return { call, ok };
}

type Client = ReturnType<typeof client>;

async function balances(c: Client) {
  const accounts = await c.ok("GET", "/api/accounts") as { code: string; balance: string }[];
  return Object.fromEntries(accounts.filter((a) => Number(a.balance) !== 0).map((a) => [a.code, Number(a.balance).toFixed(2)]));
}

/** Core checks (trial balance, stock vs ledger, GRNI) plus WIP vs works-order transactions. */
async function expectBooksIntact(c: Client) {
  expect((await c.ok("GET", "/api/reports/trial-balance")).balanced).toBe(true);
  expect(await c.ok("GET", "/api/reports/integrity")).toMatchObject({ allReconciled: true });
  expect(await c.ok("GET", "/api/mfg/integrity")).toMatchObject({ allReconciled: true });
}

beforeAll(async () => {
  db = await createPgliteDatabase();
  await migrateEdition(db);
  app = await buildEdition(db);
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe("light manufacturing vertical slice", () => {
  const c = client();
  const ids: Record<string, string> = {};

  it("signs up a maker and buys in components", async () => {
    expect((await c.call("POST", "/api/auth/signup", {
      companyName: "Sheffield Lamp Works Ltd", name: "Alex Morgan", email: "alex@lampworks.example", password: "correct horse battery",
    })).status).toBe(201);
    const product = async (sku: string, name: string, uom = "each") => (await c.ok("POST", "/api/products", { sku, name, uom })).id as string;
    ids.lamp = await product("LAMP-01", "Desk lamp");
    ids.base = await product("BASE-01", "Lamp base (sub-assembly)");
    ids.shade = await product("SHADE-01", "Linen shade");
    ids.screw = await product("SCR-M4", "M4 screw");
    ids.steel = await product("STL-SHEET", "Steel sheet", "kg");
    ids.supplier = (await c.ok("POST", "/api/contacts", { kind: "supplier", name: "Midlands Components Ltd" })).id;
    const po = await c.ok("POST", "/api/purchase-orders", {
      supplierId: ids.supplier, date: "2026-10-01",
      lines: [
        { productId: ids.shade, quantity: 20, unitPrice: "6.50", vatCode: "S20" },
        { productId: ids.screw, quantity: 500, unitPrice: "0.02", vatCode: "S20" },
        { productId: ids.steel, quantity: 50, unitPrice: "3.00", vatCode: "S20" },
      ],
    });
    await c.ok("POST", `/api/purchase-orders/${po.id}/approve`);
    const detail = await c.ok("GET", `/api/purchase-orders/${po.id}`);
    await c.ok("POST", `/api/purchase-orders/${po.id}/receive`, {
      date: "2026-10-02", lines: detail.lines.map((l: { id: string; quantity: string }) => ({ poLineId: l.id, quantity: l.quantity })),
    });
    expect(await balances(c)).toMatchObject({ "1001": "290.00", "2105": "-290.00" });
  });

  it("sets up work centres and a two-level bill of materials", async () => {
    ids.assy = (await c.ok("POST", "/api/mfg/work-centres", { code: "assy", name: "Assembly bench", labourRate: "18.00", overheadRate: "12.00" })).id;
    ids.fab = (await c.ok("POST", "/api/mfg/work-centres", { code: "FAB", name: "Fabrication cell", labourRate: "20.00", overheadRate: "30.00" })).id;
    ids.baseBom = (await c.ok("POST", "/api/mfg/boms", {
      productId: ids.base, outputQty: 10,
      lines: [{ componentId: ids.screw, quantity: 40, wastagePct: 5 }, { componentId: ids.steel, quantity: 5 }],
      operations: [{ workCentreId: ids.fab, description: "Cut, fold and weld", setupHours: 1, runHoursPerUnit: "0.1" }],
    })).id;
    ids.lampBom = (await c.ok("POST", "/api/mfg/boms", {
      productId: ids.lamp,
      lines: [{ componentId: ids.shade, quantity: 1 }, { componentId: ids.base, quantity: 1 }],
      operations: [{ workCentreId: ids.assy, description: "Assemble and test", runHoursPerUnit: "0.25" }],
    })).id;
    // A BOM that would make a cycle (screw ← lamp ← base ← screw) is refused.
    const cyclic = await c.call("POST", "/api/mfg/boms", { productId: ids.screw, lines: [{ componentId: ids.lamp, quantity: 1 }] });
    expect(cyclic.status).toBe(422);
    expect(cyclic.body.message).toContain("SCR-M4 → LAMP-01 → BASE-01 → SCR-M4");
    expect((await c.call("POST", "/api/mfg/boms", { productId: ids.lamp, lines: [{ componentId: ids.lamp, quantity: 1 }] })).status).toBe(422);
  });

  it("rolls up standard cost through both levels", async () => {
    const rollup = await c.ok("GET", "/api/mfg/cost-rollup") as { sku: string; material: string; labour: string; overhead: string; total: string; missingCosts: string[] }[];
    const by = Object.fromEntries(rollup.map((r) => [r.sku, [r.material, r.labour, r.overhead, r.total]]));
    // Base: (40 × 1.05 × 0.02 + 5 × 3) ÷ 10 = 1.584 material; (1 ÷ 10 + 0.1) h × £20 / £30.
    expect(by["BASE-01"]).toEqual(["1.584000", "4.000000", "6.000000", "11.584000"]);
    expect(by["LAMP-01"]).toEqual(["18.084000", "4.500000", "3.000000", "25.584000"]);
    const bom = await c.ok("GET", `/api/mfg/boms/${ids.lampBom}`);
    expect(bom.rollup.total).toBe("25.584000");
    expect(bom.lines.find((l: { sku: string }) => l.sku === "BASE-01").made).toBe(true);
  });

  it("reports shortages through every level for a planned lamp order", async () => {
    const wo = await c.ok("POST", "/api/mfg/works-orders", { productId: ids.lamp, quantity: 30, dueDate: "2026-11-01" });
    ids.lampWo = wo.id;
    expect(wo.number).toBe("WO-00001");
    // A planned order cannot take postings yet.
    expect((await c.call("POST", `/api/mfg/works-orders/${wo.id}/issue`, { date: "2026-10-05" })).status).toBe(422);
    const mrp = await c.ok("GET", "/api/mfg/mrp") as { sku: string; level: number; demand: string; shortage: string; action: string | null }[];
    const by = Object.fromEntries(mrp.map((r) => [r.sku, [r.level, Number(r.demand), Number(r.shortage), r.action]]));
    expect(by).toEqual({
      "SHADE-01": [1, 30, 10, "buy"],
      "BASE-01": [1, 30, 30, "make"],
      // 30 bases → 3 batches × 40 × 1.05 = 126 screws and 15 kg of steel, both covered by stock.
      "SCR-M4": [2, 126, 0, null],
      "STL-SHEET": [2, 15, 0, null],
    });
  });

  it("makes the sub-assembly: materials and conversion into WIP, out to finished goods and scrap", async () => {
    const wo = await c.ok("POST", "/api/mfg/works-orders", { productId: ids.base, quantity: 30, release: true });
    ids.baseWo = wo.id;
    // With the base order in production, MRP no longer asks for bases.
    const mrp = await c.ok("GET", "/api/mfg/mrp") as { sku: string; shortage: string }[];
    expect(Number(mrp.find((r) => r.sku === "BASE-01")!.shortage)).toBe(0);

    const issued = await c.ok("POST", `/api/mfg/works-orders/${wo.id}/issue`, { date: "2026-10-05" });
    expect(issued.cost).toBe("47.52"); // 126 × £0.02 + 15 × £3.00
    const time = await c.ok("POST", `/api/mfg/works-orders/${wo.id}/labour`, { date: "2026-10-05", workCentreId: ids.fab, hours: 4 });
    expect(time).toMatchObject({ labour: "80.00", overhead: "120.00" });
    expect(await balances(c)).toMatchObject({ "1001": "242.48", "1002": "247.52", "5400": "-80.00", "5410": "-120.00" });
    await expectBooksIntact(c);

    // Part completion: 20 of 30 take two thirds of WIP.
    const part = await c.ok("POST", `/api/mfg/works-orders/${wo.id}/complete`, { date: "2026-10-06", quantity: 20 });
    expect(part).toMatchObject({ finishedGoods: "165.01", scrap: "0.00", wipAfter: "82.51", closed: false });
    // The last 10: 9 good and 1 scrapped clears the order.
    const last = await c.ok("POST", `/api/mfg/works-orders/${wo.id}/complete`, { date: "2026-10-07", quantity: 9, scrapQuantity: 1 });
    expect(last).toMatchObject({ finishedGoods: "74.26", scrap: "8.25", variance: "0.00", wipAfter: "0.00", closed: true });

    const detail = await c.ok("GET", `/api/mfg/works-orders/${wo.id}`);
    expect(detail).toMatchObject({ status: "completed", completed_qty: "29.0000", scrapped_qty: "1.0000", wip: "0.00", completedValue: "239.27" });
    const b = await balances(c);
    expect(b["1002"]).toBeUndefined();
    expect(b).toMatchObject({ "1001": "481.75", "5300": "8.25" });
    const stock = await c.ok("GET", `/api/products/${ids.base}`);
    expect(stock.stock[0]).toMatchObject({ quantity: "29.0000", value: "239.27" });
    // Completed orders take no more postings.
    expect((await c.call("POST", `/api/mfg/works-orders/${wo.id}/labour`, { date: "2026-10-07", workCentreId: ids.fab, hours: 1 })).status).toBe(422);
    await expectBooksIntact(c);
  });

  it("makes lamps from part of the order and closes it short", async () => {
    const id = ids.lampWo!;
    await c.ok("POST", `/api/mfg/works-orders/${id}/release`);
    // Only 20 shades in stock: issuing all 30 is refused and nothing is posted.
    expect((await c.call("POST", `/api/mfg/works-orders/${id}/issue`, { date: "2026-10-08" })).status).toBe(422);
    expect((await c.call("POST", `/api/mfg/works-orders/${id}/issue`, {
      date: "2026-10-08", lines: [{ productId: ids.steel, quantity: 1 }],
    })).status).toBe(422);
    const issued = await c.ok("POST", `/api/mfg/works-orders/${id}/issue`, {
      date: "2026-10-08", lines: [{ productId: ids.shade, quantity: 20 }, { productId: ids.base, quantity: 20 }],
    });
    // 20 × £6.50 + 20 of 29 bases worth £239.27 at average cost.
    expect(issued.cost).toBe("295.01");
    await c.ok("POST", `/api/mfg/works-orders/${id}/labour`, { date: "2026-10-08", workCentreId: ids.assy, hours: 5 });
    expect((await c.call("POST", `/api/mfg/works-orders/${id}/cancel`)).status).toBe(422);
    const done = await c.ok("POST", `/api/mfg/works-orders/${id}/complete`, { date: "2026-10-09", quantity: 20, close: true });
    expect(done).toMatchObject({ finishedGoods: "445.01", closed: true });
    const detail = await c.ok("GET", `/api/mfg/works-orders/${id}`);
    expect(detail.actualUnitCost).toBe("22.250500");
    expect(detail.status).toBe("completed");
    // Nothing open, so no demand left for MRP.
    expect(await c.ok("GET", "/api/mfg/mrp")).toEqual([]);
    await expectBooksIntact(c);
  });

  it("sends WIP left on a closed order with nothing made to production variances", async () => {
    const wo = await c.ok("POST", "/api/mfg/works-orders", { productId: ids.base, quantity: 10, release: true });
    await c.ok("POST", `/api/mfg/works-orders/${wo.id}/labour`, { date: "2026-10-10", workCentreId: ids.fab, hours: "0.5" });
    expect((await c.call("POST", `/api/mfg/works-orders/${wo.id}/complete`, { date: "2026-10-10" })).status).toBe(422);
    const closed = await c.ok("POST", `/api/mfg/works-orders/${wo.id}/complete`, { date: "2026-10-10", close: true });
    expect(closed).toMatchObject({ variance: "25.00", finishedGoods: "0.00", closed: true });
    expect((await balances(c))["5310"]).toBe("25.00");
    await expectBooksIntact(c);
  });

  it("keeps each tenant's production data private and the WIP ledger append-only", async () => {
    const other = client();
    await other.ok("POST", "/api/auth/signup", {
      companyName: "Other Makers Ltd", name: "Sam Lee", email: "sam@other.example", password: "another long password",
    });
    expect(await other.ok("GET", "/api/mfg/works-orders")).toEqual([]);
    expect(await other.ok("GET", "/api/mfg/boms")).toEqual([]);
    expect((await other.call("GET", `/api/mfg/works-orders/${ids.baseWo}`)).status).toBe(404);
    await expect(db.system((tx) => tx.query("UPDATE mfg_wo_transactions SET value = 0"))).rejects.toThrow(/append-only/);
    await expect(db.system((tx) => tx.query("DELETE FROM mfg_bom_lines"))).rejects.toThrow(/append-only/);
  });
});
