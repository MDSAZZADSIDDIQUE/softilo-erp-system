import { newId } from "@softilo/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inTenant, requireWrite } from "../lib/context.js";
import { notFound } from "../lib/errors.js";
import { audit } from "../lib/ledger.js";
import { currency, IdParams, isoDate, unitPrice, vatCode } from "../lib/schemas.js";

const Address = z.object({
  line1: z.string().max(200).optional(), line2: z.string().max(200).optional(),
  city: z.string().max(100).optional(), postcode: z.string().max(10).optional(),
  country: z.string().max(2).optional(),
}).default({});

const Contact = z.object({
  kind: z.enum(["customer", "supplier", "both"]),
  name: z.string().trim().min(1).max(200),
  email: z.email().optional().or(z.literal("")),
  phone: z.string().max(40).optional(),
  companyNumber: z.string().trim().max(8).optional(),
  vatNumber: z.string().trim().max(14).optional(),
  currency: currency.default("GBP"),
  paymentTermsDays: z.number().int().min(0).max(365).default(30),
  address: Address,
});

const Product = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  uom: z.string().max(20).default("each"),
  hsCode: z.string().regex(/^\d{6,10}$/, "Commodity codes are 6–10 digits").optional().or(z.literal("")),
  barcode: z.string().max(64).optional(),
  weightKg: z.union([z.string(), z.number()]).transform(String).optional(),
  volumeM3: z.union([z.string(), z.number()]).transform(String).optional(),
  salesPrice: unitPrice.default("0"),
  salesVatCode: vatCode.default("S20"),
  purchaseVatCode: vatCode.default("S20"),
  trackStock: z.boolean().default(true),
  reorderLevel: z.union([z.string(), z.number()]).transform(String).optional(),
});

export async function registerMasterData(app: FastifyInstance) {
  // ---------------------------------------------------------------- settings
  app.get("/api/settings", (req) => inTenant(req, async (tx) => {
    const [t] = await tx.query("SELECT id, name, company_number, vat_number, vat_scheme, lock_date, address FROM tenants");
    return t;
  }));

  app.patch("/api/settings", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "settings");
    const body = z.object({
      name: z.string().trim().min(2).max(160).optional(),
      companyNumber: z.string().trim().max(8).nullable().optional(),
      vatNumber: z.string().trim().max(14).nullable().optional(),
      vatScheme: z.enum(["standard", "cash"]).optional(),
      lockDate: isoDate.nullable().optional(),
      address: Address.optional(),
    }).parse(req.body);
    const [cur] = await tx.query<{ lock_date: string | null }>("SELECT lock_date FROM tenants");
    // Only owners can move the lock date backwards (re-opening a closed period).
    if (body.lockDate !== undefined && cur?.lock_date && (body.lockDate === null || body.lockDate < cur.lock_date)) {
      if (ctx.role !== "owner") throw Object.assign(new Error("Only the owner can re-open a locked period"), { statusCode: 403 });
    }
    await tx.query(
      `UPDATE tenants SET name = coalesce($1, name), company_number = CASE WHEN $2::boolean THEN $3 ELSE company_number END,
         vat_number = CASE WHEN $4::boolean THEN $5 ELSE vat_number END, vat_scheme = coalesce($6, vat_scheme),
         lock_date = CASE WHEN $7::boolean THEN $8::date ELSE lock_date END, address = coalesce($9::jsonb, address)`,
      [body.name ?? null, body.companyNumber !== undefined, body.companyNumber ?? null,
        body.vatNumber !== undefined, body.vatNumber?.replace(/^GB/i, "") ?? null, body.vatScheme ?? null,
        body.lockDate !== undefined, body.lockDate ?? null, body.address ? JSON.stringify(body.address) : null],
    );
    await audit(tx, ctx, "settings.updated", "tenant", ctx.tenantId, body);
    return { ok: true };
  }));

  // ---------------------------------------------------------------- contacts
  app.get("/api/contacts", (req) => inTenant(req, async (tx) => {
    const q = z.object({ kind: z.enum(["customer", "supplier"]).optional(), search: z.string().optional() }).parse(req.query);
    return tx.query(
      `SELECT c.*,
         coalesce((SELECT sum(total - amount_paid) FROM sales_invoices i WHERE i.customer_id = c.id AND i.kind = 'invoice'), 0)
         - coalesce((SELECT sum(total - amount_paid) FROM sales_invoices i WHERE i.customer_id = c.id AND i.kind = 'credit'), 0) AS receivable,
         coalesce((SELECT sum(total - amount_paid) FROM supplier_bills b WHERE b.supplier_id = c.id AND b.kind = 'bill'), 0)
         - coalesce((SELECT sum(total - amount_paid) FROM supplier_bills b WHERE b.supplier_id = c.id AND b.kind = 'credit'), 0) AS payable
       FROM contacts c
       WHERE NOT archived AND ($1::text IS NULL OR kind = $1 OR kind = 'both')
         AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%')
       ORDER BY name`,
      [q.kind ?? null, q.search ?? null],
    );
  }));

  app.get("/api/contacts/:id", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const [c] = await tx.query("SELECT * FROM contacts WHERE id = $1", [id]);
    if (!c) throw notFound("Contact");
    return c;
  }));

  app.post("/api/contacts", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const c = Contact.parse(req.body);
    const id = newId();
    await tx.query(
      `INSERT INTO contacts (id, tenant_id, kind, name, email, phone, company_number, vat_number, currency, payment_terms_days, address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, ctx.tenantId, c.kind, c.name, c.email || null, c.phone ?? null, c.companyNumber || null,
        c.vatNumber?.replace(/^GB/i, "") || null, c.currency, c.paymentTermsDays, JSON.stringify(c.address)],
    );
    await audit(tx, ctx, "contact.created", "contact", id, c);
    return reply.status(201).send({ id });
  }));

  app.patch("/api/contacts/:id", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const c = Contact.partial().extend({ archived: z.boolean().optional() }).parse(req.body);
    const rows = await tx.query(
      `UPDATE contacts SET kind = coalesce($2, kind), name = coalesce($3, name), email = coalesce($4, email),
         phone = coalesce($5, phone), company_number = coalesce($6, company_number), vat_number = coalesce($7, vat_number),
         currency = coalesce($8, currency), payment_terms_days = coalesce($9, payment_terms_days),
         address = coalesce($10::jsonb, address), archived = coalesce($11, archived)
       WHERE id = $1 RETURNING id`,
      [id, c.kind ?? null, c.name ?? null, c.email ?? null, c.phone ?? null, c.companyNumber ?? null,
        c.vatNumber ?? null, c.currency ?? null, c.paymentTermsDays ?? null,
        c.address ? JSON.stringify(c.address) : null, c.archived ?? null],
    );
    if (!rows.length) throw notFound("Contact");
    await audit(tx, ctx, "contact.updated", "contact", id, c);
    return { ok: true };
  }));

  // ---------------------------------------------------------------- warehouses
  app.get("/api/warehouses", (req) => inTenant(req, (tx) => tx.query("SELECT * FROM warehouses ORDER BY code")));

  app.post("/api/warehouses", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const w = z.object({ code: z.string().trim().min(1).max(20).transform((s) => s.toUpperCase()), name: z.string().trim().min(1).max(100) }).parse(req.body);
    const id = newId();
    await tx.query("INSERT INTO warehouses (id, tenant_id, code, name) VALUES ($1,$2,$3,$4)", [id, ctx.tenantId, w.code, w.name]);
    await audit(tx, ctx, "warehouse.created", "warehouse", id, w);
    return reply.status(201).send({ id });
  }));

  // ---------------------------------------------------------------- products
  app.get("/api/products", (req) => inTenant(req, async (tx) => {
    const q = z.object({ search: z.string().optional() }).parse(req.query);
    return tx.query(
      `SELECT p.*, coalesce(sum(b.quantity), 0) AS on_hand, coalesce(sum(b.value), 0) AS stock_value,
              CASE WHEN sum(b.quantity) > 0 THEN round(sum(b.value) / sum(b.quantity), 6) ELSE 0 END AS average_cost
         FROM products p LEFT JOIN stock_balances b ON b.product_id = p.id
        WHERE NOT p.archived AND ($1::text IS NULL OR p.sku ILIKE '%' || $1 || '%' OR p.name ILIKE '%' || $1 || '%')
        GROUP BY p.id ORDER BY p.sku`,
      [q.search ?? null],
    );
  }));

  app.get("/api/products/:id", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const [p] = await tx.query("SELECT * FROM products WHERE id = $1", [id]);
    if (!p) throw notFound("Product");
    const stock = await tx.query(
      `SELECT w.id AS warehouse_id, w.code, w.name, coalesce(b.quantity, 0) AS quantity, coalesce(b.value, 0) AS value
         FROM warehouses w LEFT JOIN stock_balances b ON b.warehouse_id = w.id AND b.product_id = $1 ORDER BY w.code`, [id]);
    const movements = await tx.query(
      `SELECT m.date, m.kind, m.quantity, m.value, m.source_type, m.source_id, w.code AS warehouse
         FROM stock_movements m JOIN warehouses w ON w.id = m.warehouse_id
        WHERE m.product_id = $1 ORDER BY m.date DESC, m.created_at DESC LIMIT 100`, [id]);
    return { ...p, stock, movements };
  }));

  app.post("/api/products", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const p = Product.parse(req.body);
    const id = newId();
    await tx.query(
      `INSERT INTO products (id, tenant_id, sku, name, description, uom, hs_code, barcode, weight_kg, volume_m3,
         sales_price, sales_vat_code, purchase_vat_code, track_stock, reorder_level)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, ctx.tenantId, p.sku, p.name, p.description ?? null, p.uom, p.hsCode || null, p.barcode ?? null,
        p.weightKg ?? null, p.volumeM3 ?? null, p.salesPrice, p.salesVatCode, p.purchaseVatCode, p.trackStock, p.reorderLevel ?? null],
    );
    await audit(tx, ctx, "product.created", "product", id, p);
    return reply.status(201).send({ id });
  }));

  app.patch("/api/products/:id", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const p = Product.partial().omit({ trackStock: true }).extend({ archived: z.boolean().optional() }).parse(req.body);
    const rows = await tx.query(
      `UPDATE products SET sku = coalesce($2, sku), name = coalesce($3, name), description = coalesce($4, description),
         uom = coalesce($5, uom), hs_code = coalesce($6, hs_code), barcode = coalesce($7, barcode),
         weight_kg = coalesce($8::numeric, weight_kg), volume_m3 = coalesce($9::numeric, volume_m3),
         sales_price = coalesce($10::numeric, sales_price), sales_vat_code = coalesce($11, sales_vat_code),
         purchase_vat_code = coalesce($12, purchase_vat_code), reorder_level = coalesce($13::numeric, reorder_level),
         archived = coalesce($14, archived)
       WHERE id = $1 RETURNING id`,
      [id, p.sku ?? null, p.name ?? null, p.description ?? null, p.uom ?? null, p.hsCode ?? null, p.barcode ?? null,
        p.weightKg ?? null, p.volumeM3 ?? null, p.salesPrice ?? null, p.salesVatCode ?? null, p.purchaseVatCode ?? null,
        p.reorderLevel ?? null, p.archived ?? null],
    );
    if (!rows.length) throw notFound("Product");
    await audit(tx, ctx, "product.updated", "product", id, p);
    return { ok: true };
  }));
}
