import { newId, type Sql } from "@softilo/db";
import { d, postSalesInvoice, toFixed, type VatCode } from "@softilo/domain";
import {
  assessAwr, checkPlacement, checkTimesheet, engagementDefaults, isEditable, marginReport, postWorkerPayAccrual,
  priceTimesheet, qualifiesWithin, REC_CHART, timesheetInvoiceLines, type Absence, type AbsenceReason, type Engagement,
  type RecAccounts, type TimesheetStatus,
} from "@softilo/recruitment-domain";
import { inTenant, requireWrite, type Ctx } from "@softilo/api/lib/context";
import { notFound, unprocessable } from "@softilo/api/lib/errors";
import { audit, loadRoles, nextNumber, postJournal } from "@softilo/api/lib/ledger";
import { addDays, IdParams, isoDate, today, uuid, vatCode } from "@softilo/api/lib/schemas";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

// ---------------------------------------------------------------- input schemas

const rateValue = z.union([z.string(), z.number()]).transform(String)
  .refine((v) => /^\d{1,13}(\.\d{1,4})?$/.test(v), "Must be a rate with at most 4 decimal places");
const fraction = z.union([z.string(), z.number()]).transform(String)
  .refine((v) => /^0(\.\d{1,4})?$/.test(v), "Use a decimal fraction below 1, e.g. 0.1207 for 12.07%");
const hoursValue = z.union([z.string(), z.number()]).transform(String)
  .refine((v) => /^\d{1,2}(\.\d{1,2})?$/.test(v) && Number(v) > 0, "Hours must be positive with at most 2 decimal places");
const rateType = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_ -]{0,29}$/, "Rate types are short names, e.g. standard");

const ClientInput = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.email().optional().or(z.literal("")),
  phone: z.string().max(40).optional(),
  companyNumber: z.string().trim().regex(/^[A-Z0-9]{8}$/i).optional().or(z.literal("")),
  vatNumber: z.string().trim().regex(/^(GB)?\d{9}(\d{3})?$/i).optional().or(z.literal("")),
  paymentTermsDays: z.number().int().min(0).max(180).default(30),
  clientSize: z.enum(["small", "medium_large"]),
  vatCode: vatCode.default("S20"),
  termsAgreedOn: isoDate.optional(),
});

const WorkerInput = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.email().optional().or(z.literal("")),
  phone: z.string().max(40).optional(),
  engagement: z.enum(["paye", "umbrella", "ltd"]),
  umbrellaName: z.string().trim().max(160).optional(),
  companyName: z.string().trim().max(160).optional(),
  companyNumber: z.string().trim().regex(/^[A-Z0-9]{8}$/i).optional().or(z.literal("")),
  ir35Status: z.enum(["inside", "outside"]).optional(),
  kidIssuedOn: isoDate.optional(),
  conductRegsOptOut: z.boolean().default(false),
}).superRefine((w, ctx) => {
  if (w.engagement === "umbrella" && !w.umbrellaName) ctx.addIssue({ code: "custom", path: ["umbrellaName"], message: "Name the umbrella company" });
  if (w.engagement === "ltd" && !w.companyName) ctx.addIssue({ code: "custom", path: ["companyName"], message: "Name the contractor's limited company" });
  if (w.engagement !== "ltd" && (w.ir35Status || w.conductRegsOptOut)) {
    ctx.addIssue({ code: "custom", path: ["ir35Status"], message: "IR35 status and the Conduct Regulations opt-out apply only to limited-company contractors" });
  }
});

const PlacementInput = z.object({
  clientId: uuid,
  workerId: uuid,
  consultantId: uuid.optional(),
  jobTitle: z.string().trim().min(1).max(160),
  startDate: isoDate,
  endDate: isoDate.optional(),
  holidayRate: fraction.optional(),
  onCostRate: fraction.optional(),
  awrApplies: z.boolean().optional(),
  awrStart: isoDate.optional(),
  sdsReceivedOn: isoDate.optional(),
  rates: z.array(z.object({ rateType, payRate: rateValue, chargeRate: rateValue })).min(1).max(10),
});

const TimesheetInput = z.object({
  placementId: uuid,
  weekEnding: isoDate,
  entries: z.array(z.object({ date: isoDate, rateType, hours: hoursValue })).min(1).max(100),
  submit: z.boolean().default(false),
});

const AbsenceInput = z.object({
  startDate: isoDate,
  endDate: isoDate,
  reason: z.enum(["annual_leave", "sickness", "jury_service", "hirer_shutdown", "strike", "pregnancy_maternity", "family_leave", "other"]),
  notes: z.string().max(500).optional(),
});

const InvoiceInput = z.object({
  clientId: uuid,
  date: isoDate,
  timesheetIds: z.array(uuid).min(1).optional(),
});

// ---------------------------------------------------------------- helpers

/** Add the recruitment accounts to a tenant's chart the first time they are needed. */
export async function recAccountsFor(tx: Sql, ctx: Ctx): Promise<RecAccounts> {
  for (const a of REC_CHART) {
    await tx.query(
      `INSERT INTO accounts (tenant_id, code, name, type, role, is_control, is_bank) VALUES ($1,$2,$3,$4,$5,$6,false)
       ON CONFLICT DO NOTHING`,
      [ctx.tenantId, a.code, a.name, a.type, a.role, a.control ?? false]);
  }
  const rows = await tx.query<{ role: string; code: string }>("SELECT role, code FROM accounts WHERE role LIKE 'rec\\_%'");
  const map = Object.fromEntries(rows.map((r) => [r.role, r.code])) as RecAccounts;
  const missing = REC_CHART.filter((a) => !map[a.role]);
  if (missing.length) {
    throw unprocessable(`Account codes ${missing.map((a) => a.code).join(", ")} are already used; free them for the recruitment accounts`);
  }
  return map;
}

async function recNumber(tx: Sql, ctx: Ctx, kind: "rec_placement" | "rec_timesheet"): Promise<string> {
  const prefix = kind === "rec_placement" ? "PL" : "TS";
  const [row] = await tx.query<{ value: string }>(
    `INSERT INTO number_sequences (tenant_id, kind, prefix, next_value) VALUES ($1, $2, $3, 2)
     ON CONFLICT (tenant_id, kind) DO UPDATE SET next_value = number_sequences.next_value + 1
     RETURNING next_value - 1 AS value`,
    [ctx.tenantId, kind, prefix]);
  return `${prefix}-${String(row!.value).padStart(5, "0")}`;
}

type PlacementRow = {
  id: string; number: string; client_id: string; worker_id: string; consultant_id: string | null; job_title: string;
  start_date: string; end_date: string | null; status: string; holiday_rate: string; on_cost_rate: string;
  awr_applies: boolean; awr_start: string; sds_received_on: string | null;
};

async function loadPlacement(tx: Sql, id: string, lock = false) {
  const [p] = await tx.query<PlacementRow>(`SELECT * FROM rec_placements WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`, [id]);
  if (!p) throw notFound("Placement");
  const rates = await tx.query<{ rate_type: string; pay_rate: string; charge_rate: string }>(
    "SELECT rate_type, pay_rate, charge_rate FROM rec_placement_rates WHERE placement_id = $1 ORDER BY pay_rate, rate_type", [id]);
  return { ...p, rates: rates.map((r) => ({ rateType: r.rate_type, payRate: r.pay_rate, chargeRate: r.charge_rate })) };
}

/** AWR assessment for a placement: worked days come from every timesheet with the same hirer, role and AWR start. */
async function awrFor(tx: Sql, p: PlacementRow, asOf: string) {
  const worked = await tx.query<{ date: string }>(
    `SELECT DISTINCT l.date FROM rec_timesheet_lines l JOIN rec_timesheets t ON t.id = l.timesheet_id
       JOIN rec_placements q ON q.id = t.placement_id
      WHERE q.worker_id = $1 AND q.client_id = $2 AND lower(q.job_title) = lower($3) AND q.awr_start = $4
        AND t.status IN ('submitted','approved','invoiced')`,
    [p.worker_id, p.client_id, p.job_title, p.awr_start]);
  const absences = await tx.query<{ start_date: string; end_date: string; reason: AbsenceReason }>(
    "SELECT start_date, end_date, reason FROM rec_absences WHERE placement_id = $1", [p.id]);
  return assessAwr({
    start: p.awr_start, asOf,
    workedDates: worked.map((w) => w.date),
    absences: absences.map<Absence>((a) => ({ start: a.start_date, end: a.end_date, reason: a.reason })),
  });
}

async function saveEntries(tx: Sql, ctx: Ctx, timesheetId: string, p: Awaited<ReturnType<typeof loadPlacement>>,
  weekEnding: string, entries: z.infer<typeof TimesheetInput>["entries"]) {
  const errors = checkTimesheet({ weekEnding, placementStart: p.start_date, placementEnd: p.end_date, rates: p.rates, entries });
  if (errors.length) throw unprocessable(errors.join("; "));
  const priced = priceTimesheet(p.rates, entries, { holidayRate: p.holiday_rate, onCostRate: p.on_cost_rate });
  await tx.query("DELETE FROM rec_timesheet_lines WHERE timesheet_id = $1", [timesheetId]);
  for (const e of entries) {
    await tx.query("INSERT INTO rec_timesheet_lines (id, tenant_id, timesheet_id, date, rate_type, hours) VALUES ($1,$2,$3,$4,$5,$6)",
      [newId(), ctx.tenantId, timesheetId, e.date, e.rateType, e.hours]);
  }
  await tx.query(
    "UPDATE rec_timesheets SET hours = $2, pay = $3, holiday = $4, on_costs = $5, charge = $6 WHERE id = $1",
    [timesheetId, toFixed(priced.hours), toFixed(priced.pay), toFixed(priced.holiday), toFixed(priced.onCosts), toFixed(priced.charge)]);
}

async function loadTimesheet(tx: Sql, id: string) {
  const [t] = await tx.query<{ id: string; number: string; placement_id: string; week_ending: string; status: TimesheetStatus }>(
    "SELECT id, number, placement_id, week_ending, status FROM rec_timesheets WHERE id = $1 FOR UPDATE", [id]);
  if (!t) throw notFound("Timesheet");
  return t;
}

const TIMESHEET_LIST = `
  SELECT t.id, t.number, t.week_ending, t.status, t.hours, t.pay, t.holiday, t.on_costs, t.charge,
         t.pay + t.holiday + t.on_costs AS cost, t.charge - (t.pay + t.holiday + t.on_costs) AS margin,
         t.approved_by, t.approved_at, t.rejected_reason, t.invoice_id, i.number AS invoice_number, e.number AS accrual_number,
         p.id AS placement_id, p.number AS placement_number, p.job_title, p.client_id, c.name AS client_name,
         w.first_name || ' ' || w.last_name AS worker_name, w.engagement
    FROM rec_timesheets t JOIN rec_placements p ON p.id = t.placement_id JOIN contacts c ON c.id = p.client_id
    JOIN rec_workers w ON w.id = p.worker_id
    LEFT JOIN sales_invoices i ON i.id = t.invoice_id LEFT JOIN journal_entries e ON e.id = t.accrual_entry_id`;

// ---------------------------------------------------------------- routes

export async function registerRecruitment(app: FastifyInstance) {
  // ------------------------------------------------ consultants
  app.get("/api/rec/consultants", (req) => inTenant(req, (tx) =>
    tx.query("SELECT * FROM rec_consultants WHERE NOT archived ORDER BY name")));

  app.post("/api/rec/consultants", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const c = z.object({ name: z.string().trim().min(1).max(120), email: z.email().optional().or(z.literal("")) }).parse(req.body);
    const id = newId();
    await tx.query("INSERT INTO rec_consultants (id, tenant_id, name, email) VALUES ($1,$2,$3,$4)", [id, ctx.tenantId, c.name, c.email || null]);
    await audit(tx, ctx, "rec_consultant.created", "rec_consultant", id, c);
    return reply.status(201).send({ id });
  }));

  // ------------------------------------------------ clients
  app.get("/api/rec/clients", (req) => inTenant(req, (tx) => tx.query(
    `SELECT c.id, c.name, c.email, c.vat_number, c.company_number, c.payment_terms_days, r.client_size, r.vat_code, r.terms_agreed_on,
            (SELECT count(*) FROM rec_placements p WHERE p.client_id = c.id AND p.status = 'active')::int AS active_placements,
            (SELECT coalesce(sum(i.total - i.amount_paid), 0) FROM sales_invoices i WHERE i.customer_id = c.id AND i.kind = 'invoice') AS outstanding
       FROM rec_clients r JOIN contacts c ON c.id = r.contact_id ORDER BY c.name`)));

  app.post("/api/rec/clients", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const c = ClientInput.parse(req.body);
    const id = newId();
    await tx.query(
      `INSERT INTO contacts (id, tenant_id, kind, name, email, phone, company_number, vat_number, currency, payment_terms_days)
       VALUES ($1,$2,'customer',$3,$4,$5,$6,$7,'GBP',$8)`,
      [id, ctx.tenantId, c.name, c.email || null, c.phone ?? null, c.companyNumber || null,
        c.vatNumber?.replace(/^GB/i, "") || null, c.paymentTermsDays]);
    await tx.query("INSERT INTO rec_clients (contact_id, tenant_id, client_size, vat_code, terms_agreed_on) VALUES ($1,$2,$3,$4,$5)",
      [id, ctx.tenantId, c.clientSize, c.vatCode, c.termsAgreedOn ?? null]);
    await audit(tx, ctx, "rec_client.created", "contact", id, c);
    return reply.status(201).send({ id });
  }));

  // ------------------------------------------------ workers
  app.get("/api/rec/workers", (req) => inTenant(req, (tx) => tx.query(
    `SELECT w.*, w.first_name || ' ' || w.last_name AS name,
            (SELECT count(*) FROM rec_placements p WHERE p.worker_id = w.id AND p.status = 'active')::int AS active_placements
       FROM rec_workers w WHERE NOT archived ORDER BY last_name, first_name`)));

  app.get("/api/rec/workers/:id", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const [w] = await tx.query("SELECT *, first_name || ' ' || last_name AS name FROM rec_workers WHERE id = $1", [id]);
    if (!w) throw notFound("Worker");
    const placements = await tx.query(
      `SELECT p.id, p.number, p.job_title, p.start_date, p.end_date, p.status, c.name AS client_name
         FROM rec_placements p JOIN contacts c ON c.id = p.client_id WHERE p.worker_id = $1 ORDER BY p.start_date DESC`, [id]);
    return { ...w, placements };
  }));

  app.post("/api/rec/workers", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const w = WorkerInput.parse(req.body);
    const id = newId();
    await tx.query(
      `INSERT INTO rec_workers (id, tenant_id, first_name, last_name, email, phone, engagement, umbrella_name, company_name,
         company_number, ir35_status, kid_issued_on, conduct_regs_opt_out) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, ctx.tenantId, w.firstName, w.lastName, w.email || null, w.phone ?? null, w.engagement,
        w.engagement === "umbrella" ? w.umbrellaName : null, w.engagement === "ltd" ? w.companyName : null,
        w.companyNumber || null, w.ir35Status ?? null, w.kidIssuedOn ?? null, w.conductRegsOptOut]);
    await audit(tx, ctx, "rec_worker.created", "rec_worker", id, { ...w, email: undefined, phone: undefined });
    return reply.status(201).send({ id });
  }));

  // ------------------------------------------------ placements
  app.get("/api/rec/placements", (req) => inTenant(req, (tx) => tx.query(
    `SELECT p.*, c.name AS client_name, w.first_name || ' ' || w.last_name AS worker_name, w.engagement, w.ir35_status,
            k.name AS consultant_name,
            (SELECT min(charge_rate - pay_rate) FROM rec_placement_rates r WHERE r.placement_id = p.id) AS min_spread,
            (SELECT r.pay_rate FROM rec_placement_rates r WHERE r.placement_id = p.id ORDER BY r.pay_rate LIMIT 1) AS pay_rate,
            (SELECT r.charge_rate FROM rec_placement_rates r WHERE r.placement_id = p.id ORDER BY r.pay_rate LIMIT 1) AS charge_rate
       FROM rec_placements p JOIN contacts c ON c.id = p.client_id JOIN rec_workers w ON w.id = p.worker_id
       LEFT JOIN rec_consultants k ON k.id = p.consultant_id ORDER BY p.status, p.start_date DESC`)));

  app.get("/api/rec/placements/:id", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const p = await loadPlacement(tx, id);
    const [info] = await tx.query<{ client_name: string; worker_name: string; engagement: Engagement; ir35_status: string | null;
      kid_issued_on: string | null; client_size: "small" | "medium_large"; consultant_name: string | null }>(
      `SELECT c.name AS client_name, w.first_name || ' ' || w.last_name AS worker_name, w.engagement, w.ir35_status, w.kid_issued_on,
              r.client_size, k.name AS consultant_name
         FROM rec_placements p JOIN contacts c ON c.id = p.client_id JOIN rec_clients r ON r.contact_id = p.client_id
         JOIN rec_workers w ON w.id = p.worker_id LEFT JOIN rec_consultants k ON k.id = p.consultant_id WHERE p.id = $1`, [id]);
    const timesheets = await tx.query(`${TIMESHEET_LIST} WHERE t.placement_id = $1 ORDER BY t.week_ending DESC`, [id]);
    const absences = await tx.query("SELECT * FROM rec_absences WHERE placement_id = $1 ORDER BY start_date", [id]);
    const checks = checkPlacement({
      engagement: info!.engagement, ir35Status: info!.ir35_status as "inside" | "outside" | null, clientSize: info!.client_size,
      sdsReceivedOn: p.sds_received_on, kidIssuedOn: info!.kid_issued_on, startDate: p.start_date, rates: p.rates,
    });
    const awr = p.awr_applies ? await awrFor(tx, p, today()) : null;
    return { ...p, ...info, timesheets, absences, awr, warnings: checks.warnings };
  }));

  app.post("/api/rec/placements", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const input = PlacementInput.parse(req.body);
    const [client] = await tx.query<{ client_size: "small" | "medium_large" }>(
      "SELECT client_size FROM rec_clients WHERE contact_id = $1", [input.clientId]);
    if (!client) throw unprocessable("Client not found");
    const [worker] = await tx.query<{ engagement: Engagement; ir35_status: "inside" | "outside" | null; kid_issued_on: string | null }>(
      "SELECT engagement, ir35_status, kid_issued_on FROM rec_workers WHERE id = $1 AND NOT archived", [input.workerId]);
    if (!worker) throw unprocessable("Worker not found");
    if (input.consultantId) {
      const [k] = await tx.query("SELECT 1 FROM rec_consultants WHERE id = $1", [input.consultantId]);
      if (!k) throw unprocessable("Consultant not found");
    }
    if (input.endDate && input.endDate < input.startDate) throw unprocessable("The end date is before the start date");
    if (input.awrStart && input.awrStart > input.startDate) throw unprocessable("The AWR start cannot be after the placement starts");
    const checks = checkPlacement({
      engagement: worker.engagement, ir35Status: worker.ir35_status, clientSize: client.client_size,
      sdsReceivedOn: input.sdsReceivedOn, kidIssuedOn: worker.kid_issued_on, startDate: input.startDate, rates: input.rates,
    });
    if (checks.errors.length) throw unprocessable(checks.errors.join("; "));
    const defaults = engagementDefaults(worker.engagement);
    const id = newId();
    const number = await recNumber(tx, ctx, "rec_placement");
    await tx.query(
      `INSERT INTO rec_placements (id, tenant_id, number, client_id, worker_id, consultant_id, job_title, start_date, end_date,
         holiday_rate, on_cost_rate, awr_applies, awr_start, sds_received_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, ctx.tenantId, number, input.clientId, input.workerId, input.consultantId ?? null, input.jobTitle, input.startDate,
        input.endDate ?? null, input.holidayRate ?? defaults.holidayRate, input.onCostRate ?? "0",
        input.awrApplies ?? defaults.awrApplies, input.awrStart ?? input.startDate, input.sdsReceivedOn ?? null]);
    for (const r of input.rates) {
      await tx.query(
        "INSERT INTO rec_placement_rates (id, tenant_id, placement_id, rate_type, pay_rate, charge_rate) VALUES ($1,$2,$3,$4,$5,$6)",
        [newId(), ctx.tenantId, id, r.rateType, r.payRate, r.chargeRate]);
    }
    await audit(tx, ctx, "rec_placement.created", "rec_placement", id, { number, ...input });
    return reply.status(201).send({ id, number, warnings: checks.warnings });
  }));

  app.post("/api/rec/placements/:id/end", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const { endDate } = z.object({ endDate: isoDate }).parse(req.body);
    const p = await loadPlacement(tx, id, true);
    if (endDate < p.start_date) throw unprocessable("The end date is before the start date");
    const [late] = await tx.query("SELECT 1 FROM rec_timesheet_lines l JOIN rec_timesheets t ON t.id = l.timesheet_id WHERE t.placement_id = $1 AND l.date > $2 LIMIT 1", [id, endDate]);
    if (late) throw unprocessable("There are hours recorded after that date");
    await tx.query("UPDATE rec_placements SET end_date = $2, status = 'ended' WHERE id = $1", [id, endDate]);
    await audit(tx, ctx, "rec_placement.ended", "rec_placement", id, { endDate });
    return { ok: true };
  }));

  app.post("/api/rec/placements/:id/absences", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const a = AbsenceInput.parse(req.body);
    if (a.endDate < a.startDate) throw unprocessable("The end date is before the start date");
    await loadPlacement(tx, id);
    const absenceId = newId();
    await tx.query("INSERT INTO rec_absences (id, tenant_id, placement_id, start_date, end_date, reason, notes) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [absenceId, ctx.tenantId, id, a.startDate, a.endDate, a.reason, a.notes ?? null]);
    await audit(tx, ctx, "rec_absence.recorded", "rec_placement", id, a);
    return reply.status(201).send({ id: absenceId });
  }));

  // ------------------------------------------------ timesheets
  app.get("/api/rec/timesheets", (req) => inTenant(req, (tx) => {
    const { status } = z.object({ status: z.enum(["draft", "submitted", "approved", "rejected", "invoiced"]).optional() }).parse(req.query);
    return status
      ? tx.query(`${TIMESHEET_LIST} WHERE t.status = $1 ORDER BY t.week_ending DESC, t.number DESC`, [status])
      : tx.query(`${TIMESHEET_LIST} ORDER BY t.week_ending DESC, t.number DESC`);
  }));

  app.get("/api/rec/timesheets/:id", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const [t] = await tx.query(`${TIMESHEET_LIST} WHERE t.id = $1`, [id]);
    if (!t) throw notFound("Timesheet");
    const entries = await tx.query("SELECT date, rate_type, hours FROM rec_timesheet_lines WHERE timesheet_id = $1 ORDER BY date, rate_type", [id]);
    const frozen = await tx.query("SELECT rate_type, hours, pay_rate, charge_rate, pay, charge FROM rec_timesheet_rates WHERE timesheet_id = $1 ORDER BY pay_rate", [id]);
    const placement = await loadPlacement(tx, (t as { placement_id: string }).placement_id);
    return { ...t, entries, rates: frozen.length ? frozen : placement.rates.map((r) => ({ rate_type: r.rateType, pay_rate: r.payRate, charge_rate: r.chargeRate })) };
  }));

  app.post("/api/rec/timesheets", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const input = TimesheetInput.parse(req.body);
    const p = await loadPlacement(tx, input.placementId);
    const [dup] = await tx.query<{ number: string }>("SELECT number FROM rec_timesheets WHERE placement_id = $1 AND week_ending = $2",
      [p.id, input.weekEnding]);
    if (dup) throw unprocessable(`${dup.number} already covers the week ending ${input.weekEnding}`);
    const id = newId();
    const number = await recNumber(tx, ctx, "rec_timesheet");
    await tx.query("INSERT INTO rec_timesheets (id, tenant_id, number, placement_id, week_ending, status) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, ctx.tenantId, number, p.id, input.weekEnding, input.submit ? "submitted" : "draft"]);
    await saveEntries(tx, ctx, id, p, input.weekEnding, input.entries);
    await audit(tx, ctx, "rec_timesheet.created", "rec_timesheet", id, { number, submit: input.submit });
    return reply.status(201).send({ id, number });
  }));

  app.put("/api/rec/timesheets/:id", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const input = TimesheetInput.omit({ placementId: true, weekEnding: true }).parse(req.body);
    const t = await loadTimesheet(tx, id);
    if (!isEditable(t.status)) throw unprocessable(`${t.number} is ${t.status} and its hours can no longer be changed`);
    await saveEntries(tx, ctx, id, await loadPlacement(tx, t.placement_id), t.week_ending, input.entries);
    if (input.submit) await tx.query("UPDATE rec_timesheets SET status = 'submitted', rejected_reason = NULL WHERE id = $1", [id]);
    await audit(tx, ctx, "rec_timesheet.updated", "rec_timesheet", id, { submit: input.submit });
    return { ok: true };
  }));

  app.post("/api/rec/timesheets/:id/submit", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const t = await loadTimesheet(tx, id);
    if (!isEditable(t.status)) throw unprocessable(`${t.number} is already ${t.status}`);
    await tx.query("UPDATE rec_timesheets SET status = 'submitted', rejected_reason = NULL WHERE id = $1", [id]);
    await audit(tx, ctx, "rec_timesheet.submitted", "rec_timesheet", id);
    return { ok: true };
  }));

  app.post("/api/rec/timesheets/:id/reject", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).parse(req.body);
    const t = await loadTimesheet(tx, id);
    if (t.status !== "submitted") throw unprocessable("Only a submitted timesheet can be rejected");
    await tx.query("UPDATE rec_timesheets SET status = 'rejected', rejected_reason = $2 WHERE id = $1", [id, reason]);
    await audit(tx, ctx, "rec_timesheet.rejected", "rec_timesheet", id, { reason });
    return { ok: true };
  }));

  /** Client approval: freezes the rates and hours and accrues the worker's pay as cost of sales. */
  app.post("/api/rec/timesheets/:id/approve", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const { approvedBy } = z.object({ approvedBy: z.string().trim().min(1).max(160) }).parse(req.body);
    const t = await loadTimesheet(tx, id);
    if (t.status !== "submitted") throw unprocessable("Only a submitted timesheet can be approved");
    const p = await loadPlacement(tx, t.placement_id);
    const entries = (await tx.query<{ date: string; rate_type: string; hours: string }>(
      "SELECT date, rate_type, hours FROM rec_timesheet_lines WHERE timesheet_id = $1", [id]))
      .map((e) => ({ date: e.date, rateType: e.rate_type, hours: e.hours }));
    const errors = checkTimesheet({ weekEnding: t.week_ending, placementStart: p.start_date, placementEnd: p.end_date, rates: p.rates, entries });
    if (errors.length) throw unprocessable(errors.join("; "));
    const priced = priceTimesheet(p.rates, entries, { holidayRate: p.holiday_rate, onCostRate: p.on_cost_rate });
    if (priced.cost.isZero()) throw unprocessable("There is no pay to accrue on this timesheet");
    for (const r of priced.byRate) {
      await tx.query(
        `INSERT INTO rec_timesheet_rates (id, tenant_id, timesheet_id, rate_type, hours, pay_rate, charge_rate, pay, charge)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [newId(), ctx.tenantId, id, r.rateType, toFixed(r.hours), r.payRate.toFixed(4), r.chargeRate.toFixed(4), toFixed(r.pay), toFixed(r.charge)]);
    }
    const [w] = await tx.query<{ name: string }>("SELECT first_name || ' ' || last_name AS name FROM rec_workers WHERE id = $1", [p.worker_id]);
    const posting = postWorkerPayAccrual(await recAccountsFor(tx, ctx), {
      date: t.week_ending, reference: `${t.number} ${p.number}`, description: `${w!.name}, w/e ${t.week_ending}`,
      pay: priced.pay, holiday: priced.holiday, onCosts: priced.onCosts,
    });
    const entry = await postJournal(tx, ctx, posting, { type: "rec_timesheet", id });
    await tx.query(
      `UPDATE rec_timesheets SET status = 'approved', approved_by = $2, approved_at = now(), accrual_entry_id = $3,
         hours = $4, pay = $5, holiday = $6, on_costs = $7, charge = $8 WHERE id = $1`,
      [id, approvedBy, entry.id, toFixed(priced.hours), toFixed(priced.pay), toFixed(priced.holiday), toFixed(priced.onCosts), toFixed(priced.charge)]);
    await audit(tx, ctx, "rec_timesheet.approved", "rec_timesheet", id, { approvedBy, cost: toFixed(priced.cost), charge: toFixed(priced.charge) });
    return { ok: true, cost: toFixed(priced.cost), charge: toFixed(priced.charge) };
  }));

  // ------------------------------------------------ billing
  /** Approved timesheets not yet invoiced, by client. */
  app.get("/api/rec/billing", (req) => inTenant(req, async (tx) => {
    const rows = await tx.query<{ client_id: string; client_name: string; charge: string; id: string }>(
      `${TIMESHEET_LIST} WHERE t.status = 'approved' ORDER BY c.name, t.week_ending, t.number`);
    const byClient = new Map<string, { clientId: string; clientName: string; charge: string; timesheets: unknown[] }>();
    for (const r of rows) {
      const g = byClient.get(r.client_id) ?? { clientId: r.client_id, clientName: r.client_name, charge: "0", timesheets: [] };
      g.charge = d(g.charge).plus(r.charge).toFixed(2);
      g.timesheets.push(r);
      byClient.set(r.client_id, g);
    }
    return [...byClient.values()];
  }));

  /** Raise a client invoice (a core sales invoice, with VAT) from approved timesheets. */
  app.post("/api/rec/invoices", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const input = InvoiceInput.parse(req.body);
    const [client] = await tx.query<{ id: string; payment_terms_days: number; vat_code: VatCode; name: string }>(
      `SELECT c.id, c.payment_terms_days, r.vat_code, c.name FROM rec_clients r JOIN contacts c ON c.id = r.contact_id WHERE c.id = $1`,
      [input.clientId]);
    if (!client) throw unprocessable("Client not found");
    const sheets = await tx.query<{ id: string; number: string; week_ending: string; worker_name: string; job_title: string; charge: string }>(
      `SELECT t.id, t.number, t.week_ending, w.first_name || ' ' || w.last_name AS worker_name, p.job_title, t.charge
         FROM rec_timesheets t JOIN rec_placements p ON p.id = t.placement_id JOIN rec_workers w ON w.id = p.worker_id
        WHERE p.client_id = $1 AND t.status = 'approved' ${input.timesheetIds ? "AND t.id = ANY($2)" : ""}
        ORDER BY t.week_ending, t.number FOR UPDATE OF t`,
      input.timesheetIds ? [client.id, input.timesheetIds] : [client.id]);
    if (input.timesheetIds && sheets.length !== new Set(input.timesheetIds).size) {
      throw unprocessable("Some timesheets are not approved, already invoiced, or belong to another client");
    }
    if (!sheets.length) throw unprocessable(`${client.name} has no approved timesheets to invoice`);
    const invoiceable = [];
    for (const s of sheets) {
      const rates = await tx.query<{ rate_type: string; hours: string; charge_rate: string; charge: string }>(
        "SELECT rate_type, hours, charge_rate, charge FROM rec_timesheet_rates WHERE timesheet_id = $1 ORDER BY pay_rate, rate_type", [s.id]);
      invoiceable.push({
        number: s.number, weekEnding: s.week_ending, workerName: s.worker_name, jobTitle: s.job_title,
        byRate: rates.map((r) => ({ rateType: r.rate_type, hours: d(r.hours), chargeRate: d(r.charge_rate), charge: d(r.charge) })),
      });
    }
    const acc = await recAccountsFor(tx, ctx);
    const roles = await loadRoles(tx);
    const lines = timesheetInvoiceLines(invoiceable, acc.rec_temp_fees, client.vat_code);
    const [wh] = await tx.query<{ id: string }>("SELECT id FROM warehouses ORDER BY code = 'MAIN' DESC, code LIMIT 1");
    if (!wh) throw unprocessable("No warehouse is set up");
    const id = newId();
    const entryId = newId();
    const number = await nextNumber(tx, ctx, "sales_invoice");
    const posting = postSalesInvoice(roles, { date: input.date, reference: number, rate: 1, lines });
    await postJournal(tx, ctx, posting, { type: "sales_invoice", id, entryId });
    await tx.query(
      `INSERT INTO sales_invoices (id, tenant_id, number, kind, customer_id, warehouse_id, customer_ref, date, due_date, currency, rate,
         total, total_gbp, entry_id) VALUES ($1,$2,$3,'invoice',$4,$5,$6,$7,$8,'GBP',1,$9,$10,$11)`,
      [id, ctx.tenantId, number, client.id, wh.id, `Timesheets ${sheets.map((s) => s.number).join(", ")}`.slice(0, 60), input.date,
        addDays(input.date, client.payment_terms_days), toFixed(posting.total), toFixed(posting.totalGbp), entryId]);
    for (const [i, l] of lines.entries()) {
      await tx.query(
        `INSERT INTO sales_invoice_lines (id, tenant_id, invoice_id, line_no, description, quantity, unit_price, net, vat_code, vat, account_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [newId(), ctx.tenantId, id, i + 1, l.description, l.quantity, l.unitPrice, toFixed(l.net), l.vatCode,
          toFixed(posting.vat[i]!.vat), l.account]);
    }
    for (const s of sheets) await tx.query("UPDATE rec_timesheets SET status = 'invoiced', invoice_id = $2 WHERE id = $1", [s.id, id]);
    await audit(tx, ctx, "rec_invoice.raised", "sales_invoice", id, { number, timesheets: sheets.map((s) => s.number), total: toFixed(posting.total) });
    return reply.status(201).send({ id, number, total: toFixed(posting.total) });
  }));

  // ------------------------------------------------ reports
  app.get("/api/rec/margin", (req) => inTenant(req, async (tx) => {
    const q = z.object({ by: z.enum(["placement", "client", "consultant"]).default("client"), from: isoDate.optional(), to: isoDate.optional() }).parse(req.query);
    const rows = await tx.query<{ key: string; label: string; hours: string; charge: string; cost: string }>(
      `SELECT ${q.by === "placement" ? "p.id::text" : q.by === "client" ? "c.id::text" : "coalesce(k.id::text, 'none')"} AS key,
              ${q.by === "placement" ? "p.number || ' · ' || w.first_name || ' ' || w.last_name || ' · ' || c.name"
                : q.by === "client" ? "c.name" : "coalesce(k.name, 'No consultant')"} AS label,
              t.hours, t.charge, t.pay + t.holiday + t.on_costs AS cost
         FROM rec_timesheets t JOIN rec_placements p ON p.id = t.placement_id JOIN contacts c ON c.id = p.client_id
         JOIN rec_workers w ON w.id = p.worker_id LEFT JOIN rec_consultants k ON k.id = p.consultant_id
        WHERE t.status IN ('approved','invoiced') AND ($1::date IS NULL OR t.week_ending >= $1) AND ($2::date IS NULL OR t.week_ending <= $2)`,
      [q.from ?? null, q.to ?? null]);
    const report = marginReport(rows);
    const out = (r: (typeof report.rows)[number]) => ({
      key: r.key, label: r.label, hours: r.hours.toFixed(2), charge: r.charge.toFixed(2), cost: r.cost.toFixed(2),
      margin: r.margin.toFixed(2), marginPct: r.marginPct?.toFixed(2) ?? null, marginPerHour: r.marginPerHour?.toFixed(2) ?? null,
    });
    return { by: q.by, rows: report.rows.map(out), total: out(report.total) };
  }));

  app.get("/api/rec/awr", (req) => inTenant(req, async (tx) => {
    const { asOf } = z.object({ asOf: isoDate.optional() }).parse(req.query);
    const date = asOf ?? today();
    const placements = await tx.query<PlacementRow & { client_name: string; worker_name: string }>(
      `SELECT p.*, c.name AS client_name, w.first_name || ' ' || w.last_name AS worker_name
         FROM rec_placements p JOIN contacts c ON c.id = p.client_id JOIN rec_workers w ON w.id = p.worker_id
        WHERE p.awr_applies AND p.status = 'active' ORDER BY p.start_date`);
    const out = [];
    for (const p of placements) {
      const a = await awrFor(tx, p, date);
      out.push({
        id: p.id, number: p.number, client_name: p.client_name, worker_name: p.worker_name, job_title: p.job_title,
        awr_start: p.awr_start, status: a.status, weeksCompleted: a.weeksCompleted, weeksRemaining: a.weeksRemaining,
        qualifiedOn: a.qualifiedOn, projectedQualifyingDate: a.projectedQualifyingDate, soon: qualifiesWithin(a, date, 28),
      });
    }
    return out;
  }));

  app.get("/api/rec/dashboard", (req) => inTenant(req, async (tx) => {
    const [s] = await tx.query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM rec_placements WHERE status = 'active')::int AS active_placements,
              (SELECT count(*) FROM rec_timesheets WHERE status = 'submitted')::int AS awaiting_approval,
              (SELECT count(*) FROM rec_timesheets WHERE status IN ('draft','rejected'))::int AS drafts,
              (SELECT coalesce(sum(charge), 0) FROM rec_timesheets WHERE status = 'approved') AS to_invoice,
              (SELECT coalesce(sum(charge), 0) FROM rec_timesheets WHERE status IN ('approved','invoiced') AND week_ending >= date_trunc('month', current_date)) AS sales_month,
              (SELECT coalesce(sum(charge - pay - holiday - on_costs), 0) FROM rec_timesheets WHERE status IN ('approved','invoiced') AND week_ending >= date_trunc('month', current_date)) AS margin_month,
              (SELECT coalesce(sum(i.total - i.amount_paid), 0) FROM sales_invoices i JOIN rec_clients r ON r.contact_id = i.customer_id WHERE i.kind = 'invoice') AS debtors`);
    return s;
  }));

  /** The worker-pay accrual accounts must equal the approved timesheet costs not yet paid (no pay runs exist yet). */
  app.get("/api/rec/integrity", (req) => inTenant(req, async (tx) => {
    const [r] = await tx.query<{ timesheets: string; ledger: string }>(
      `SELECT (SELECT coalesce(sum(pay + holiday + on_costs), 0) FROM rec_timesheets WHERE status IN ('approved','invoiced')) AS timesheets,
              (SELECT coalesce(sum(credit - debit), 0) FROM journal_lines l JOIN accounts a ON a.code = l.account_code
                WHERE a.role IN ('rec_pay_accrued','rec_holiday_accrued')) AS ledger`);
    return { timesheets: r!.timesheets, ledger: r!.ledger, reconciled: d(r!.timesheets).equals(r!.ledger) };
  }));
}
