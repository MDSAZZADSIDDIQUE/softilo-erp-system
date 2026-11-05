import { newId, type Sql } from "@softilo/db";
import { buildVatReturn, d, postPva, postVatSettlement, round2, type VatCode, type VatReturn } from "@softilo/domain";
import type { FraudPreventionData } from "../integrations/index.js";
import { hmrcAuth } from "../lib/connections.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inTenant, requireWrite } from "../lib/context.js";
import { notFound, unprocessable } from "../lib/errors.js";
import { audit, loadRoles, postJournal } from "../lib/ledger.js";
import { addDays, IdParams, isoDate, money, today, uuid } from "../lib/schemas.js";

const Period = z.object({ from: isoDate, to: isoDate }).refine((p) => p.from <= p.to, "from must be on or before to");

/** Entries not yet on a return, dated up to the end of the period (late entries roll into the next return). */
async function openEntries(tx: Sql, to: string) {
  return tx.query<{ id: string; direction: "sales" | "purchase"; vat_code: VatCode; net: string; vat: string; date: string }>(
    "SELECT id, direction, vat_code, net, vat, date FROM vat_entries WHERE vat_return_id IS NULL AND date <= $1", [to]);
}

export async function registerVat(app: FastifyInstance) {
  app.get("/api/vat/preview", (req) => inTenant(req, async (tx) => {
    const p = Period.parse(req.query);
    const entries = await openEntries(tx, p.to);
    const boxes = buildVatReturn(entries.map((e) => ({ direction: e.direction, code: e.vat_code, net: d(e.net), vat: d(e.vat) })));
    const byCode = await tx.query(
      `SELECT direction, vat_code, count(*) AS entries, sum(net) AS net, sum(vat) AS vat FROM vat_entries
        WHERE vat_return_id IS NULL AND date <= $1 GROUP BY direction, vat_code ORDER BY direction, vat_code`, [p.to]);
    const late = entries.filter((e) => e.date < p.from).length;
    return { ...p, boxes, byCode, entries: entries.length, lateEntries: late };
  }));

  app.get("/api/vat/returns", (req) => inTenant(req, (tx) => tx.query(
    "SELECT r.*, e.number AS journal_number FROM vat_returns r JOIN journal_entries e ON e.id = r.entry_id ORDER BY end_date DESC")));

  /**
   * Finalise a VAT return: stamp the entries, post the settlement journal (VAT output and input into the VAT
   * liability account), and lock the books up to the period end so nothing can change underneath the return.
   */
  app.post("/api/vat/returns", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const input = z.object({ periodKey: z.string().trim().min(1).max(10), from: isoDate, to: isoDate, lockBooks: z.boolean().default(true) })
      .refine((p) => p.from <= p.to, "from must be on or before to").parse(req.body);
    const entries = await openEntries(tx, input.to);
    if (!entries.length) throw unprocessable("There are no VAT transactions to include");
    const boxes = buildVatReturn(entries.map((e) => ({ direction: e.direction, code: e.vat_code, net: d(e.net), vat: d(e.vat) })));
    const posting = postVatSettlement(await loadRoles(tx), input.to, input.periodKey, boxes.box1, boxes.box4);
    const id = newId();
    const entry = await postJournal(tx, ctx, posting, { type: "vat_return", id });
    await tx.query(
      `INSERT INTO vat_returns (id, tenant_id, period_key, start_date, end_date, boxes, status, entry_id)
       VALUES ($1,$2,$3,$4,$5,$6,'finalised',$7)`,
      [id, ctx.tenantId, input.periodKey, input.from, input.to, JSON.stringify(boxes), entry.id]);
    await tx.query("UPDATE vat_entries SET vat_return_id = $1 WHERE id = ANY($2)", [id, entries.map((e) => e.id)]);
    if (input.lockBooks) {
      await tx.query("UPDATE tenants SET lock_date = greatest(coalesce(lock_date, $1::date), $1::date)", [input.to]);
    }
    await audit(tx, ctx, "vat_return.finalised", "vat_return", id, { periodKey: input.periodKey, boxes });
    return reply.status(201).send({ id, boxes });
  }));

  app.get("/api/vat/returns/:id", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const [r] = await tx.query("SELECT * FROM vat_returns WHERE id = $1", [id]);
    if (!r) throw notFound("VAT return");
    const byCode = await tx.query(
      `SELECT direction, vat_code, count(*) AS entries, sum(net) AS net, sum(vat) AS vat FROM vat_entries
        WHERE vat_return_id = $1 GROUP BY direction, vat_code ORDER BY direction, vat_code`, [id]);
    return { ...r, byCode };
  }));

  /** Obligations HMRC holds for the company: which periods are open and when each is due. */
  app.get("/api/vat/obligations", (req) => inTenant(req, async (tx) => {
    const q = z.object({ from: isoDate.optional(), to: isoDate.optional() }).parse(req.query);
    const auth = await hmrcAuth(tx, app.providers);
    const from = q.from ?? auth.firstPeriodStart ?? today();
    const to = q.to ?? addDays(today(), 120);
    const obligations = await app.providers.hmrc.obligations(auth, from, to);
    const local = await tx.query<{ id: string; period_key: string; status: string }>("SELECT id, period_key, status FROM vat_returns");
    return obligations.map((o) => {
      const r = local.find((l) => l.period_key === o.periodKey);
      return { ...o, returnId: r?.id ?? null, returnStatus: r?.status ?? null };
    });
  }));

  /**
   * Submit a finalised return to HMRC under Making Tax Digital. The figures sent are exactly the boxes stored
   * when it was finalised; the receipt HMRC returns is kept with the return and in the audit trail.
   */
  app.post("/api/vat/returns/:id/submit", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const { id } = IdParams.parse(req.params);
    const body = z.object({
      declaration: z.literal(true, { message: "The person submitting must confirm the declaration" }),
      fraud: z.object({
        deviceId: z.string().max(100).optional(), timezone: z.string().max(20).optional(), screens: z.string().max(200).optional(),
        windowSize: z.string().max(60).optional(), userAgent: z.string().max(500).optional(), doNotTrack: z.string().max(10).optional(),
      }).default({}),
    }).parse(req.body);
    const [r] = await tx.query<{ period_key: string; status: string; boxes: VatReturn }>("SELECT period_key, status, boxes FROM vat_returns WHERE id = $1 FOR UPDATE", [id]);
    if (!r) throw notFound("VAT return");
    if (r.status === "submitted") throw unprocessable("This return has already been submitted to HMRC");
    const auth = await hmrcAuth(tx, app.providers);
    const open = await app.providers.hmrc.obligations(auth, addDays(today(), -800), addDays(today(), 200));
    const obligation = open.find((o) => o.periodKey === r.period_key);
    if (!obligation) throw unprocessable(`HMRC has no obligation with period key ${r.period_key}. Check the period key on the return.`);
    if (obligation.status === "F") throw unprocessable(`HMRC already holds a return for ${r.period_key}`);
    const [mfa] = await tx.query<{ enabled: boolean }>("SELECT enabled_at IS NOT NULL AS enabled FROM user_mfa WHERE user_id = $1", [ctx.userId]);
    const fraud: FraudPreventionData = {
      clientPublicIp: req.ip, clientPublicPort: String(req.socket.remotePort ?? ""), clientDeviceId: body.fraud.deviceId,
      clientUserIds: { softilo: ctx.userId ?? "automation" }, clientTimezone: body.fraud.timezone, clientScreens: body.fraud.screens,
      clientWindowSize: body.fraud.windowSize, clientBrowserJsUserAgent: body.fraud.userAgent, clientBrowserDoNotTrack: body.fraud.doNotTrack,
      clientMultiFactor: mfa?.enabled ? `type=TOTP&timestamp=${encodeURIComponent(new Date().toISOString())}&unique-reference=${ctx.userId}` : undefined,
    };
    const receipt = await app.providers.hmrc.submit(auth, r.period_key, r.boxes, fraud);
    const mode = app.providers.hmrc.info().mode;
    await tx.query("UPDATE vat_returns SET status = 'submitted', hmrc_receipt = $2, submitted_at = now(), submission_mode = $3 WHERE id = $1",
      [id, JSON.stringify(receipt), mode]);
    await audit(tx, ctx, "vat_return.submitted", "vat_return", id, { periodKey: r.period_key, mode, receipt });
    return { ok: true, receipt, mode };
  }));

  // ---------------------------------------------------------------- postponed VAT accounting
  app.get("/api/vat/pva", (req) => inTenant(req, (tx) => tx.query(
    `SELECT p.*, s.number AS shipment_number FROM pva_entries p LEFT JOIN shipments s ON s.id = p.shipment_id
      ORDER BY p.date DESC, p.mrn`)));

  /** Enter lines from the monthly PVA statement downloaded from the Customs Declaration Service. */
  app.post("/api/vat/pva", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const input = z.object({
      statement: z.string().regex(/^\d{4}-\d{2}$/, "Statement month as YYYY-MM"),
      entries: z.array(z.object({
        mrn: z.string().trim().min(5).max(30),
        date: isoDate,
        valueGbp: money,
        vatGbp: money,
        shipmentId: uuid.optional(),
      })).min(1).max(1000),
    }).parse(req.body);
    const roles = await loadRoles(tx);
    const unmatched: string[] = [];
    for (const e of input.entries) {
      let shipmentId = e.shipmentId ?? null;
      if (!shipmentId) {
        const [s] = await tx.query<{ id: string }>("SELECT id FROM shipments WHERE mrn = $1", [e.mrn]);
        shipmentId = s?.id ?? null;
      }
      if (!shipmentId) unmatched.push(e.mrn);
      const id = newId();
      const posting = postPva(roles, { date: e.date, reference: e.mrn, valueGbp: round2(e.valueGbp), vatGbp: round2(e.vatGbp) });
      const entry = await postJournal(tx, ctx, posting, { type: "pva", id });
      await tx.query(
        `INSERT INTO pva_entries (id, tenant_id, statement, mrn, date, value_gbp, vat_gbp, shipment_id, entry_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, ctx.tenantId, input.statement, e.mrn, e.date, e.valueGbp, e.vatGbp, shipmentId, entry.id]);
    }
    await audit(tx, ctx, "pva.imported", "pva_statement", input.statement, { entries: input.entries.length, unmatched });
    return reply.status(201).send({ imported: input.entries.length, unmatched });
  }));
}
