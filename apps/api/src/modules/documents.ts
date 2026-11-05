import { createHash } from "node:crypto";
import { newId, type Sql } from "@softilo/db";
import { d } from "@softilo/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ExtractedDocument } from "../integrations/index.js";
import { inTenant, requireWrite, type Ctx } from "../lib/context.js";
import { fxRate } from "../lib/connections.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { audit } from "../lib/ledger.js";
import { IdParams, today } from "../lib/schemas.js";
import { BillInput, createBill } from "./purchasing.js";

type Providers = FastifyInstance["providers"];
const TEXT_TYPES = /^(text\/|application\/(json|csv|xml))/;
const ALLOWED = /^(application\/pdf|image\/(png|jpeg|webp|heic)|text\/plain|text\/csv)$/;

/** A draft bill built from what was read: matched to the supplier, purchase order and goods received where possible. */
export interface Proposal {
  supplierId: string | null;
  supplierName: string | null;
  input: Partial<z.infer<typeof BillInput>> & { lines: z.infer<typeof BillInput>["lines"] };
  matches: string[];
  warnings: string[];
}

const norm = (s: string) => s.toUpperCase().replace(/\b(LTD|LIMITED|PLC|LLP|CO|COMPANY)\b|[^A-Z0-9]/g, "");

async function propose(tx: Sql, providers: Providers, x: ExtractedDocument): Promise<Proposal> {
  const matches: string[] = [];
  const warnings: string[] = [...x.notes];
  const suppliers = await tx.query<{ id: string; name: string; vat_number: string | null; currency: string; payment_terms_days: number }>(
    "SELECT id, name, vat_number, currency, payment_terms_days FROM contacts WHERE kind IN ('supplier','both') AND NOT archived");
  let sup = x.supplierVatNumber ? suppliers.find((s) => s.vat_number === x.supplierVatNumber) : undefined;
  if (sup) matches.push(`Supplier matched on VAT number GB${x.supplierVatNumber}`);
  if (!sup && x.supplierName) {
    const n = norm(x.supplierName);
    sup = suppliers.find((s) => norm(s.name) === n) ?? suppliers.find((s) => n.length > 5 && (norm(s.name).includes(n) || n.includes(norm(s.name))));
    if (sup) matches.push(`Supplier matched on name "${sup.name}"`);
  }
  if (!sup) warnings.push(`No supplier in Softilo matches "${x.supplierName ?? "unknown"}". Choose one or add them first.`);
  if (sup && x.supplierVatNumber && sup.vat_number && sup.vat_number !== x.supplierVatNumber) {
    warnings.push(`The VAT number on the invoice (GB${x.supplierVatNumber}) differs from the one held for ${sup.name} (GB${sup.vat_number}).`);
  }
  if (sup && x.currency && x.currency !== sup.currency) warnings.push(`Invoiced in ${x.currency} but ${sup.name} is set up in ${sup.currency}.`);
  if (sup && x.invoiceNumber) {
    const [dup] = await tx.query<{ number: string }>("SELECT number FROM supplier_bills WHERE supplier_id = $1 AND upper(supplier_ref) = upper($2)", [sup.id, x.invoiceNumber]);
    if (dup) warnings.push(`Possible duplicate: ${sup.name} invoice ${x.invoiceNumber} is already entered as ${dup.number}.`);
  }

  const cur = x.currency ?? sup?.currency ?? "GBP";
  const date = x.invoiceDate ?? today();
  const lines: Proposal["input"]["lines"] = [];

  // Stock suppliers: bill against what was received on the purchase order.
  if (sup && x.docType === "supplier_invoice") {
    const grn = await tx.query<{ id: string; po_number: string; sku: string; description: string; quantity: string; net: string; unit_price: string }>(
      `SELECT gl.id, po.number AS po_number, p.sku, pl.description, gl.quantity::text, round(gl.quantity * pl.unit_price, 2)::text AS net, pl.unit_price::text
         FROM goods_receipt_lines gl JOIN purchase_order_lines pl ON pl.id = gl.po_line_id JOIN purchase_orders po ON po.id = pl.po_id
         JOIN products p ON p.id = gl.product_id
        WHERE NOT gl.billed AND po.supplier_id = $1 AND ($2::text IS NULL OR po.number = $2) ORDER BY po.date`, [sup.id, x.purchaseOrderRef]);
    if (grn.length) {
      if (x.purchaseOrderRef) matches.push(`Matched to goods received on ${x.purchaseOrderRef}`);
      for (const g of grn) {
        const hit = x.lines.find((l) => (l.sku && l.sku.toUpperCase() === g.sku.toUpperCase()) || norm(l.description).includes(norm(g.description).slice(0, 10)));
        const net = hit?.net ?? g.net;
        if (hit && !d(hit.net).equals(g.net)) warnings.push(`${g.sku}: invoiced ${hit.net} against ${g.net} at the order price. The difference will post to purchase price variance.`);
        lines.push({ kind: "receipt", receiptLineId: g.id, net, vatCode: "OS" });
      }
      const unmatched = x.lines.filter((l) => !grn.some((g) => (l.sku && l.sku.toUpperCase() === g.sku.toUpperCase()) || norm(l.description).includes(norm(g.description).slice(0, 10))));
      for (const u of unmatched) warnings.push(`"${u.description}" (${u.net}) is on the invoice but has not been received.`);
    } else if (x.purchaseOrderRef) {
      warnings.push(`Nothing received on ${x.purchaseOrderRef} is waiting to be billed. Receive the goods before posting this invoice.`);
    }
  }

  // Freight and customs: costs to land against the shipment, through landed cost clearing.
  if (!lines.length) {
    const landed = x.docType === "freight_invoice" || x.docType === "customs_entry";
    // Other bills go where this supplier's bills usually go (rent to rent, power to utilities).
    const [usual] = sup && !landed ? await tx.query<{ account_code: string; name: string }>(
      `SELECT l.account_code, a.name FROM supplier_bill_lines l JOIN supplier_bills b ON b.id = l.bill_id JOIN accounts a ON a.code = l.account_code
        WHERE b.supplier_id = $1 AND l.kind = 'account' GROUP BY l.account_code, a.name ORDER BY count(*) DESC LIMIT 1`, [sup.id]) : [];
    if (usual) matches.push(`Coded to ${usual.account_code} ${usual.name}, where ${sup!.name}'s bills usually go`);
    for (const l of x.lines.length ? x.lines : [{ description: x.docType.replace("_", " "), net: x.net ?? x.total ?? "0", vatRate: x.vat && Number(x.vat) > 0 ? "20" : "0", quantity: null, unitPrice: null, sku: null }]) {
      const isDuty = /duty|tariff/i.test(l.description);
      const rate = l.vatRate === null ? (x.vat && Number(x.vat) > 0 ? 20 : 0) : Number(l.vatRate);
      // Duty is outside the scope of VAT; international freight is zero-rated; overseas suppliers charge no UK VAT.
      const vatCode = isDuty || cur !== "GBP" ? "OS" : rate >= 19 ? "S20" : rate === 5 ? "R5" : "Z0";
      lines.push({ kind: "account", accountCode: landed ? "2110" : usual?.account_code ?? "7500", description: [l.description, x.containerRef, x.mrn].filter(Boolean).join(" "), net: l.net, vatCode });
    }
    if (landed) matches.push("Coded to landed cost clearing (2110), ready to land on the shipment");
    if (x.containerRef || x.mrn) {
      const [s] = await tx.query<{ number: string }>("SELECT number FROM shipments WHERE reference = $1 OR mrn = $2", [x.containerRef, x.mrn]);
      if (s) matches.push(`Relates to shipment ${s.number}`);
    }
  }

  const rate = cur === "GBP" ? undefined : (await fxRate(tx, providers, cur, date))?.rate;
  if (rate) matches.push(`Exchange rate ${Number(rate).toFixed(4)} for ${date} filled in from reference rates`);
  return {
    supplierId: sup?.id ?? null, supplierName: sup?.name ?? x.supplierName,
    input: { kind: x.docType === "credit_note" ? "credit" : "bill", supplierId: sup?.id, supplierRef: x.invoiceNumber ?? undefined, date, dueDate: x.dueDate ?? undefined, currency: cur, rate, lines },
    matches, warnings,
  };
}

/** Read one document with the configured AI provider, propose a draft, and record what the model said. */
export async function readDocument(tx: Sql, ctx: Ctx, providers: Providers, id: string) {
  const [doc] = await tx.query<{ id: string; filename: string; media_type: string; content: string }>(
    "SELECT id, filename, media_type, content FROM documents WHERE id = $1 FOR UPDATE", [id]);
  if (!doc) throw notFound("Document");
  const ai = providers.ai.info();
  try {
    const isBase64 = !TEXT_TYPES.test(doc.media_type);
    const x = await providers.ai.extract({ filename: doc.filename, mediaType: doc.media_type, content: doc.content, isBase64 });
    const { model, inputTokens, outputTokens, ...extraction } = x;
    const proposal = await propose(tx, providers, extraction);
    const status = extraction.confidence >= 0.8 && !proposal.warnings.length && proposal.supplierId ? "extracted" : "needs_review";
    await tx.query(
      `UPDATE documents SET status = $2, doc_type = $3, extraction = $4, extractor = $5, confidence = $6, warnings = $7, extracted_at = now(), error = NULL
        WHERE id = $1`,
      [id, status, extraction.docType, JSON.stringify({ ...extraction, proposal }), model ?? "demo-rules", extraction.confidence, JSON.stringify(proposal.warnings)]);
    await tx.query(
      `INSERT INTO ai_interactions (id, tenant_id, user_id, kind, provider, model, input, output, input_tokens, output_tokens)
       VALUES ($1,$2,$3,'extraction',$4,$5,$6,$7,$8,$9)`,
      [newId(), ctx.tenantId, ctx.userId, ai.mode === "live" ? "gemini" : "demo", model, JSON.stringify({ documentId: id, filename: doc.filename }),
        JSON.stringify(extraction), inputTokens ?? null, outputTokens ?? null]);
    await audit(tx, ctx, "document.read", "document", id, { status, docType: extraction.docType, confidence: extraction.confidence, model });
    return { id, status, doc_type: extraction.docType, confidence: extraction.confidence, error: null };
  } catch (e) {
    const error = (e as Error).message;
    await tx.query("UPDATE documents SET status = 'failed', error = $2 WHERE id = $1", [id, error]);
    return { id, status: "failed", doc_type: null, confidence: null, error };
  }
}

export async function storeDocument(tx: Sql, ctx: Ctx, f: { filename: string; mediaType: string; content: string; source?: string }) {
  const isText = TEXT_TYPES.test(f.mediaType);
  const bytes = isText ? Buffer.byteLength(f.content) : Buffer.from(f.content, "base64").length;
  const sha = createHash("sha256").update(f.content).digest("hex");
  const [dup] = await tx.query<{ id: string }>("SELECT id FROM documents WHERE sha256 = $1", [sha]);
  if (dup) return { id: dup.id, duplicate: true };
  const id = newId();
  await tx.query(
    `INSERT INTO documents (id, tenant_id, filename, media_type, content, size_bytes, sha256, source, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, ctx.tenantId, f.filename, f.mediaType, f.content, bytes, sha, f.source ?? "upload", ctx.userId]);
  await audit(tx, ctx, "document.received", "document", id, { filename: f.filename, size: bytes });
  return { id, duplicate: false };
}

export async function registerDocuments(app: FastifyInstance) {
  app.get("/api/documents", (req) => inTenant(req, (tx) => tx.query(
    `SELECT d.id, d.filename, d.media_type, d.size_bytes, d.source, d.status, d.doc_type, d.extractor, d.confidence, d.warnings,
            d.linked_type, d.linked_id, d.error, d.created_at, d.extracted_at, b.number AS bill_number,
            d.extraction->>'supplierName' AS supplier_name, d.extraction->>'total' AS total, d.extraction->>'currency' AS currency,
            d.extraction->>'invoiceNumber' AS invoice_number
       FROM documents d LEFT JOIN supplier_bills b ON b.id = d.linked_id ORDER BY d.created_at DESC LIMIT 200`)));

  app.get("/api/documents/:id", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const [doc] = await tx.query<Record<string, unknown> & { media_type: string; content: string }>(
      "SELECT d.*, b.number AS bill_number FROM documents d LEFT JOIN supplier_bills b ON b.id = d.linked_id WHERE d.id = $1", [id]);
    if (!doc) throw notFound("Document");
    // Text is shown inline; binary files are served by /file so the page can preview them.
    return { ...doc, content: TEXT_TYPES.test(doc.media_type) ? doc.content : undefined };
  }));

  app.get("/api/documents/:id/file", (req, reply) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const [doc] = await tx.query<{ media_type: string; content: string; filename: string }>("SELECT media_type, content, filename FROM documents WHERE id = $1", [id]);
    if (!doc) throw notFound("Document");
    const body = TEXT_TYPES.test(doc.media_type) ? Buffer.from(doc.content) : Buffer.from(doc.content, "base64");
    return reply.header("content-type", doc.media_type).header("content-disposition", `inline; filename="${doc.filename.replace(/"/g, "")}"`)
      .header("x-content-type-options", "nosniff").header("content-security-policy", "sandbox").send(body);
  }));

  app.post("/api/documents", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const f = z.object({
      filename: z.string().trim().min(1).max(200),
      mediaType: z.string().regex(ALLOWED, "Upload a PDF, an image (PNG, JPEG, WebP) or a text file"),
      content: z.string().min(1).max(5_500_000),
      read: z.boolean().default(true),
    }).parse(req.body);
    const stored = await storeDocument(tx, ctx, f);
    if (stored.duplicate) return reply.status(200).send({ ...stored, message: "This file is already in the inbox" });
    const result = f.read ? await readDocument(tx, ctx, app.providers, stored.id) : null;
    return reply.status(201).send({ ...stored, result });
  }));

  app.post("/api/documents/:id/read", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const { id } = IdParams.parse(req.params);
    const [doc] = await tx.query<{ status: string }>("SELECT status FROM documents WHERE id = $1", [id]);
    if (!doc) throw notFound("Document");
    if (doc.status === "converted") throw unprocessable("This document has already been turned into a bill");
    return readDocument(tx, ctx, app.providers, id);
  }));

  /** The reviewer's (possibly corrected) bill. Posting goes through the same rules as a bill typed in by hand. */
  app.post("/api/documents/:id/convert", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const { id } = IdParams.parse(req.params);
    const [doc] = await tx.query<{ status: string; filename: string }>("SELECT status, filename FROM documents WHERE id = $1 FOR UPDATE", [id]);
    if (!doc) throw notFound("Document");
    if (doc.status === "converted") throw unprocessable("This document has already been turned into a bill");
    const bill = await createBill(tx, ctx, BillInput.parse(req.body));
    await tx.query("UPDATE documents SET status = 'converted', linked_type = 'supplier_bill', linked_id = $2 WHERE id = $1", [id, bill.id]);
    await audit(tx, ctx, "document.converted", "document", id, { billId: bill.id, number: bill.number });
    return reply.status(201).send(bill);
  }));

  app.post("/api/documents/:id/reject", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const { id } = IdParams.parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(1).max(300) }).parse(req.body);
    const rows = await tx.query("UPDATE documents SET status = 'rejected', error = $2 WHERE id = $1 AND status <> 'converted' RETURNING id", [id, reason]);
    if (!rows.length) throw unprocessable("Document not found, or already turned into a bill");
    await audit(tx, ctx, "document.rejected", "document", id, { reason });
    return { ok: true };
  }));
}
