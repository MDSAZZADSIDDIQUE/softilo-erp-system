import { newId, type Sql } from "@softilo/db";
import { d, lineVat, sum, toFixed, type VatCode } from "@softilo/domain";
import {
  buildCis300, CATEGORY_ACCOUNTS, CONSTRUCTION_ACCOUNTS, constructionSalesVat, jobCostSummary, paymentTimetable,
  postApplication, postJobBill, purchaseVatDefault, taxMonthEnding, valueApplication,
  type CisBillWithPayments, type CisStatus, type CostCategory, type Subcontractor,
} from "@softilo/construction-domain";
import { inTenant, requireWrite, type Ctx } from "@softilo/api/dist/lib/context.js";
import { notFound, unprocessable } from "@softilo/api/dist/lib/errors.js";
import { audit, loadRoles, nextNumber, postJournal } from "@softilo/api/dist/lib/ledger.js";
import { IdParams, isoDate, money, positiveMoney, uuid, vatCode } from "@softilo/api/dist/lib/schemas.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { StubCisGateway, type CisGateway } from "./hmrc/cis-gateway.js";

const category = z.enum(["labour", "materials", "plant", "other"]);
const rate = z.union([z.string(), z.number()]).transform(String)
  .refine((v) => /^0(\.\d{1,4})?$/.test(v) && Number(v) <= 0.2, "Use a decimal between 0 and 0.2, e.g. 0.05 for 5%");
const days = z.number().int().min(0).max(120);

const ProjectInput = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(200),
  customerId: uuid,
  siteAddress: z.string().max(500).optional(),
  contractSum: money.refine((v) => Number(v) >= 0, "Cannot be negative"),
  retentionRate: rate.default("0.05"),
  vatRate: z.enum(["standard", "reduced", "zero"]).default("standard"),
  customerCisRegistered: z.boolean().default(true),
  endUserNotice: z.boolean().default(false),
  fivePercentDisregard: z.boolean().default(false),
  dueDays: days.default(7),
  finalDays: days.default(17),
  paymentNoticeDays: days.default(5),
  payLessDays: days.default(7),
  startDate: isoDate.optional(),
  budget: z.array(z.object({ category, description: z.string().trim().min(1).max(200), amount: money })).default([]),
});

const SubcontractorInput = z.object({
  contactId: uuid.optional(),
  name: z.string().trim().min(1).max(200).optional(),
  vatNumber: z.string().trim().max(14).optional(),
  businessType: z.enum(["sole_trader", "partnership", "company", "trust"]),
  utr: z.string().trim().regex(/^\d{10}$/, "A UTR is 10 digits"),
  nino: z.string().trim().max(9).optional(),
  companyNumber: z.string().trim().max(8).optional(),
}).refine((s) => s.contactId || s.name, "Give an existing contact or a name");

const JobBillInput = z.object({
  supplierId: uuid,
  projectId: uuid,
  supplierRef: z.string().trim().min(1).max(60),
  date: isoDate,
  dueDate: isoDate.optional(),
  lines: z.array(z.object({
    category,
    description: z.string().trim().min(1).max(500),
    net: positiveMoney,
    vatCode: vatCode.optional(),
  })).min(1).max(200),
});

const ApplicationInput = z.object({
  date: isoDate,
  periodEnd: isoDate,
  grossToDate: money,
  stage: z.enum(["interim", "practical_completion", "final"]).default("interim"),
});

/** Add the construction accounts to a tenant's chart if they are not there yet. */
export async function ensureConstructionAccounts(tx: Sql, tenantId: string) {
  for (const a of CONSTRUCTION_ACCOUNTS) {
    await tx.query(
      `INSERT INTO accounts (tenant_id, code, name, type, role, is_control) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [tenantId, a.code, a.name, a.type, a.role ?? null, a.control ?? false]);
  }
}

async function roleCode(tx: Sql, role: string): Promise<string> {
  const [a] = await tx.query<{ code: string }>("SELECT code FROM accounts WHERE role = $1", [role]);
  if (!a) throw unprocessable(`The ${role} account is missing from the chart`);
  return a.code;
}

async function project(tx: Sql, id: string, lock = false) {
  const [p] = await tx.query<Record<string, unknown> & {
    id: string; code: string; customer_id: string; contract_sum: string; retention_rate: string; vat_rate: "standard" | "reduced" | "zero";
    customer_cis_registered: boolean; end_user_notice: boolean; five_percent_disregard: boolean;
    due_days: number; final_days: number; payment_notice_days: number; pay_less_days: number; status: string;
  }>(`SELECT p.*, c.name AS customer_name, c.vat_number AS customer_vat_number
        FROM cons_projects p JOIN contacts c ON c.id = p.customer_id WHERE p.id = $1${lock ? " FOR UPDATE OF p" : ""}`, [id]);
  if (!p) throw notFound("Project");
  return p;
}

async function projectDetail(tx: Sql, id: string) {
  const p = await project(tx, id);
  const budget = await tx.query<{ id: string; category: CostCategory; description: string; amount: string }>(
    "SELECT id, category, description, amount FROM cons_budget_lines WHERE project_id = $1 ORDER BY category, description", [id]);
  const costs = await tx.query<{ category: CostCategory; amount: string }>(
    "SELECT category, sum(amount) AS amount FROM cons_cost_entries WHERE project_id = $1 GROUP BY category", [id]);
  const variations = await tx.query<{ id: string; number: string; description: string; amount: string; status: string; date: string }>(
    "SELECT id, number, description, amount, status, date FROM cons_variations WHERE project_id = $1 ORDER BY number", [id]);
  const applications = await tx.query<Record<string, unknown> & { gross_to_date: string }>(
    `SELECT a.id, a.application_no, a.reference, a.stage, a.date, a.period_end, a.gross_to_date, a.retention_to_date, a.amount_due,
            a.vat_code, a.vat, a.total, a.final_date, a.pay_less_by, i.number AS invoice_number, i.total - i.amount_paid AS outstanding
       FROM cons_applications a JOIN sales_invoices i ON i.id = a.sales_invoice_id WHERE a.project_id = $1 ORDER BY a.application_no`, [id]);
  const bills = await tx.query(
    `SELECT b.id, b.number, b.supplier_ref, b.date, c.name AS supplier_name, j.gross, j.deduction, j.cis_status, b.total, b.total - b.amount_paid AS outstanding
       FROM cons_job_bills j JOIN supplier_bills b ON b.id = j.supplier_bill_id JOIN contacts c ON c.id = b.supplier_id
      WHERE j.project_id = $1 ORDER BY b.date DESC, b.number DESC`, [id]);
  const summary = jobCostSummary({
    contractSum: p.contract_sum,
    variations: variations.filter((v) => v.status === "approved").map((v) => v.amount),
    budget, costs,
    valuedToDate: applications.at(-1)?.gross_to_date ?? "0",
  });
  return { ...p, budget, variations, applications, bills, summary };
}

async function subcontractorRows(tx: Sql) {
  return tx.query<{ contact_id: string; name: string; vat_number: string | null; business_type: string; utr: string; nino: string | null;
    company_number: string | null; cis_status: string; verification_number: string | null; verified_at: string | null }>(
    `SELECT s.*, c.name, c.vat_number FROM cons_subcontractors s JOIN contacts c ON c.id = s.contact_id ORDER BY c.name`);
}

/** All CIS bills with the payments allocated to them, for the CIS300. */
async function cisBills(tx: Sql): Promise<CisBillWithPayments[]> {
  const bills = await tx.query<{ id: string; number: string; supplier_ref: string; supplier_id: string; payable: string; gross: string; materials: string; deduction: string }>(
    `SELECT b.id, b.number, b.supplier_ref, b.supplier_id, j.payable, j.gross, j.materials, j.deduction
       FROM cons_job_bills j JOIN supplier_bills b ON b.id = j.supplier_bill_id WHERE j.cis_status IS NOT NULL`);
  const pays = await tx.query<{ document_id: string; date: string; number: string; amount: string }>(
    `SELECT a.document_id, p.date, p.number, a.amount FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
      WHERE a.document_type = 'supplier_bill' AND a.document_id IN (SELECT supplier_bill_id FROM cons_job_bills WHERE cis_status IS NOT NULL)`);
  return bills.map((b) => ({
    billId: b.id, billNumber: b.number, supplierRef: b.supplier_ref, subcontractorId: b.supplier_id,
    payable: b.payable, gross: b.gross, materials: b.materials, deduction: b.deduction,
    payments: pays.filter((p) => p.document_id === b.id).map((p) => ({ date: p.date, sequence: p.number, amount: p.amount })),
  }));
}

async function cisPreview(tx: Sql, monthEnding: string) {
  let month;
  try {
    month = taxMonthEnding(monthEnding);
  } catch (e) {
    throw unprocessable((e as Error).message);
  }
  const subs: Subcontractor[] = (await subcontractorRows(tx)).map((s) => ({
    id: s.contact_id, name: s.name, utr: s.utr, status: (s.cis_status === "unverified" ? "unmatched" : s.cis_status) as CisStatus,
    verificationNumber: s.verification_number,
  }));
  return buildCis300(month, subs, await cisBills(tx));
}

/** Sub-ledgers against their control accounts. */
async function integrity(tx: Sql) {
  const [r] = await tx.query<{ apps: string; ledger: string }>(
    `SELECT (SELECT coalesce(sum(retention_movement), 0) FROM cons_applications) AS apps,
            (SELECT coalesce(sum(debit - credit), 0) FROM journal_lines l JOIN accounts a ON a.code = l.account_code WHERE a.role = 'cons_retentions') AS ledger`);
  const [c] = await tx.query<{ bills: string; ledger: string }>(
    `SELECT (SELECT coalesce(sum(deduction), 0) FROM cons_job_bills) AS bills,
            (SELECT coalesce(sum(credit - debit), 0) FROM journal_lines l JOIN accounts a ON a.code = l.account_code WHERE a.role = 'cons_cis_liability') AS ledger`);
  const retentions = { subLedger: r!.apps, ledger: r!.ledger, reconciled: d(r!.apps).equals(r!.ledger) };
  // No HMRC payments are recorded yet, so every deduction is still owed.
  const cis = { deductions: c!.bills, ledger: c!.ledger, reconciled: d(c!.bills).equals(c!.ledger) };
  return { retentions, cis, allReconciled: retentions.reconciled && cis.reconciled };
}

export interface ConstructionOptions {
  cis?: CisGateway;
}

export async function registerConstruction(app: FastifyInstance, opts: ConstructionOptions = {}) {
  const gateway = opts.cis ?? new StubCisGateway();
  const write = <T>(req: Parameters<typeof inTenant>[0], area: "finance" | "operations", fn: (tx: Sql, ctx: Ctx) => Promise<T>) =>
    inTenant(req, async (tx, ctx) => {
      requireWrite(ctx, area);
      await ensureConstructionAccounts(tx, ctx.tenantId);
      return fn(tx, ctx);
    });

  // ---------------------------------------------------------------- settings
  app.get("/api/construction/settings", (req) => inTenant(req, async (tx) => {
    const [s] = await tx.query("SELECT contractor_utr, employer_ref, accounts_office_ref FROM cons_settings");
    return s ?? { contractor_utr: null, employer_ref: null, accounts_office_ref: null };
  }));

  app.put("/api/construction/settings", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "settings");
    const s = z.object({
      contractorUtr: z.string().trim().regex(/^\d{10}$/, "A UTR is 10 digits").optional().or(z.literal("")),
      employerRef: z.string().trim().regex(/^\d{3}\/[A-Z0-9]{1,10}$/i, "Employer references look like 123/AB45678").optional().or(z.literal("")),
      accountsOfficeRef: z.string().trim().max(13).optional(),
    }).parse(req.body);
    await tx.query(
      `INSERT INTO cons_settings (tenant_id, contractor_utr, employer_ref, accounts_office_ref) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id) DO UPDATE SET contractor_utr = $2, employer_ref = $3, accounts_office_ref = $4, updated_at = now()`,
      [ctx.tenantId, s.contractorUtr || null, s.employerRef?.toUpperCase() || null, s.accountsOfficeRef || null]);
    await audit(tx, ctx, "construction.settings_updated", "tenant", ctx.tenantId, s);
    return { ok: true };
  }));

  // ---------------------------------------------------------------- projects
  app.get("/api/construction/projects", (req) => inTenant(req, (tx) => tx.query(
    `SELECT p.id, p.code, p.name, p.status, p.contract_sum, p.retention_rate, c.name AS customer_name,
            p.contract_sum + coalesce((SELECT sum(amount) FROM cons_variations v WHERE v.project_id = p.id AND v.status = 'approved'), 0) AS contract_value,
            (SELECT coalesce(sum(amount), 0) FROM cons_budget_lines b WHERE b.project_id = p.id) AS budget,
            (SELECT coalesce(sum(amount), 0) FROM cons_cost_entries e WHERE e.project_id = p.id) AS cost_to_date,
            coalesce((SELECT gross_to_date FROM cons_applications a WHERE a.project_id = p.id ORDER BY application_no DESC LIMIT 1), 0) AS valued_to_date,
            coalesce((SELECT retention_to_date FROM cons_applications a WHERE a.project_id = p.id ORDER BY application_no DESC LIMIT 1), 0) AS retention_held
       FROM cons_projects p JOIN contacts c ON c.id = p.customer_id ORDER BY p.status, p.code`)));

  app.get("/api/construction/projects/:id", (req) => inTenant(req, (tx) => projectDetail(tx, IdParams.parse(req.params).id)));

  app.post("/api/construction/projects", (req, reply) => write(req, "operations", async (tx, ctx) => {
    const p = ProjectInput.parse(req.body);
    const [cust] = await tx.query<{ kind: string }>("SELECT kind FROM contacts WHERE id = $1 AND NOT archived", [p.customerId]);
    if (!cust || cust.kind === "supplier") throw unprocessable("Customer not found");
    const [dup] = await tx.query("SELECT 1 FROM cons_projects WHERE code = $1", [p.code]);
    if (dup) throw unprocessable(`There is already a project with code ${p.code}`);
    const id = newId();
    await tx.query(
      `INSERT INTO cons_projects (id, tenant_id, code, name, customer_id, site_address, contract_sum, retention_rate, vat_rate,
         customer_cis_registered, end_user_notice, five_percent_disregard, due_days, final_days, payment_notice_days, pay_less_days, start_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [id, ctx.tenantId, p.code, p.name, p.customerId, p.siteAddress ?? null, p.contractSum, p.retentionRate, p.vatRate,
        p.customerCisRegistered, p.endUserNotice, p.fivePercentDisregard, p.dueDays, p.finalDays, p.paymentNoticeDays, p.payLessDays, p.startDate ?? null]);
    for (const b of p.budget) {
      await tx.query("INSERT INTO cons_budget_lines (id, tenant_id, project_id, category, description, amount) VALUES ($1,$2,$3,$4,$5,$6)",
        [newId(), ctx.tenantId, id, b.category, b.description, b.amount]);
    }
    await audit(tx, ctx, "project.created", "cons_project", id, { code: p.code, contractSum: p.contractSum });
    return reply.status(201).send({ id });
  }));

  app.put("/api/construction/projects/:id/budget", (req) => write(req, "operations", async (tx, ctx) => {
    const { id } = IdParams.parse(req.params);
    const lines = z.array(z.object({ category, description: z.string().trim().min(1).max(200), amount: money })).parse(req.body);
    await project(tx, id, true);
    await tx.query("DELETE FROM cons_budget_lines WHERE project_id = $1", [id]);
    for (const b of lines) {
      await tx.query("INSERT INTO cons_budget_lines (id, tenant_id, project_id, category, description, amount) VALUES ($1,$2,$3,$4,$5,$6)",
        [newId(), ctx.tenantId, id, b.category, b.description, b.amount]);
    }
    await audit(tx, ctx, "project.budget_set", "cons_project", id, { lines: lines.length, total: toFixed(sum(lines.map((l) => l.amount))) });
    return { ok: true };
  }));

  app.post("/api/construction/projects/:id/variations", (req, reply) => write(req, "operations", async (tx, ctx) => {
    const { id } = IdParams.parse(req.params);
    const v = z.object({ description: z.string().trim().min(1).max(500), amount: money, date: isoDate }).parse(req.body);
    await project(tx, id, true);
    const [{ n }] = await tx.query<{ n: string }>("SELECT count(*) + 1 AS n FROM cons_variations WHERE project_id = $1", [id]) as [{ n: string }];
    const number = `V${String(n).padStart(3, "0")}`;
    const vid = newId();
    await tx.query("INSERT INTO cons_variations (id, tenant_id, project_id, number, description, amount, date) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [vid, ctx.tenantId, id, number, v.description, v.amount, v.date]);
    await audit(tx, ctx, "variation.created", "cons_variation", vid, { number, amount: v.amount });
    return reply.status(201).send({ id: vid, number });
  }));

  for (const decision of ["approve", "reject"] as const) {
    app.post(`/api/construction/variations/:id/${decision}`, (req) => write(req, "operations", async (tx, ctx) => {
      const { id } = IdParams.parse(req.params);
      const rows = await tx.query(
        "UPDATE cons_variations SET status = $2, decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING id",
        [id, decision === "approve" ? "approved" : "rejected"]);
      if (!rows.length) throw unprocessable("Variation not found, or already decided");
      await audit(tx, ctx, `variation.${decision}d`, "cons_variation", id);
      return { ok: true };
    }));
  }

  // ---------------------------------------------------------------- subcontractors
  app.get("/api/construction/subcontractors", (req) => inTenant(req, (tx) => subcontractorRows(tx)));

  app.post("/api/construction/subcontractors", (req, reply) => write(req, "finance", async (tx, ctx) => {
    const s = SubcontractorInput.parse(req.body);
    let contactId = s.contactId;
    if (contactId) {
      const [c] = await tx.query<{ kind: string }>("SELECT kind FROM contacts WHERE id = $1 AND NOT archived", [contactId]);
      if (!c || c.kind === "customer") throw unprocessable("Supplier not found");
    } else {
      contactId = newId();
      await tx.query("INSERT INTO contacts (id, tenant_id, kind, name, vat_number, company_number) VALUES ($1,$2,'supplier',$3,$4,$5)",
        [contactId, ctx.tenantId, s.name, s.vatNumber || null, s.companyNumber || null]);
    }
    const [dup] = await tx.query("SELECT 1 FROM cons_subcontractors WHERE contact_id = $1", [contactId]);
    if (dup) throw unprocessable("This supplier is already set up as a subcontractor");
    await tx.query(
      "INSERT INTO cons_subcontractors (contact_id, tenant_id, business_type, utr, nino, company_number) VALUES ($1,$2,$3,$4,$5,$6)",
      [contactId, ctx.tenantId, s.businessType, s.utr, s.nino?.toUpperCase() || null, s.companyNumber || null]);
    await audit(tx, ctx, "subcontractor.created", "contact", contactId, { utr: s.utr, businessType: s.businessType });
    return reply.status(201).send({ id: contactId });
  }));

  app.post("/api/construction/subcontractors/:id/verify", (req) => write(req, "finance", async (tx, ctx) => {
    const { id } = IdParams.parse(req.params);
    const [s] = (await subcontractorRows(tx)).filter((r) => r.contact_id === id);
    if (!s) throw notFound("Subcontractor");
    const [settings] = await tx.query<{ contractor_utr: string | null; employer_ref: string | null }>("SELECT contractor_utr, employer_ref FROM cons_settings");
    let result;
    try {
      result = await gateway.verify({
        contractorUtr: settings?.contractor_utr ?? null, employerRef: settings?.employer_ref ?? null,
        businessType: s.business_type as never, name: s.name, utr: s.utr, nino: s.nino, companyNumber: s.company_number,
      });
    } catch (e) {
      throw unprocessable(`HMRC could not verify this subcontractor: ${(e as Error).message}`);
    }
    await tx.query("UPDATE cons_subcontractors SET cis_status = $2, verification_number = $3, verified_at = now() WHERE contact_id = $1",
      [id, result.status, result.verificationNumber]);
    await tx.query(
      "INSERT INTO cons_verifications (id, tenant_id, contact_id, status, verification_number, gateway, response) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [newId(), ctx.tenantId, id, result.status, result.verificationNumber, gateway.name, JSON.stringify(result.raw)]);
    await audit(tx, ctx, "subcontractor.verified", "contact", id, { status: result.status, verificationNumber: result.verificationNumber, gateway: gateway.name });
    return { status: result.status, verificationNumber: result.verificationNumber, gateway: gateway.name };
  }));

  // ---------------------------------------------------------------- job bills (with CIS)
  app.get("/api/construction/bills", (req) => inTenant(req, (tx) => tx.query(
    `SELECT b.id, b.number, b.supplier_ref, b.date, b.due_date, b.total, b.amount_paid, b.total - b.amount_paid AS outstanding,
            c.name AS supplier_name, p.code AS project_code, p.name AS project_name, j.cis_status, j.cis_rate, j.gross, j.materials, j.deduction
       FROM cons_job_bills j JOIN supplier_bills b ON b.id = j.supplier_bill_id JOIN contacts c ON c.id = b.supplier_id
       JOIN cons_projects p ON p.id = j.project_id ORDER BY b.date DESC, b.number DESC`)));

  app.post("/api/construction/bills", (req, reply) => write(req, "finance", async (tx, ctx) => {
    const input = JobBillInput.parse(req.body);
    const [sup] = await tx.query<{ id: string; kind: string; vat_number: string | null; payment_terms_days: number; currency: string; cis_status: string | null }>(
      `SELECT c.id, c.kind, c.vat_number, c.payment_terms_days, c.currency, s.cis_status
         FROM contacts c LEFT JOIN cons_subcontractors s ON s.contact_id = c.id WHERE c.id = $1 AND NOT c.archived`, [input.supplierId]);
    if (!sup || sup.kind === "customer") throw unprocessable("Supplier not found");
    if (sup.currency !== "GBP") throw unprocessable("Job bills are in pounds sterling");
    const proj = await project(tx, input.projectId);
    if (proj.status === "closed") throw unprocessable("This project is closed");
    const isSub = sup.cis_status !== null;
    if (sup.cis_status === "unverified") throw unprocessable("Verify this subcontractor with HMRC before entering their bills");
    const [dup] = await tx.query("SELECT 1 FROM supplier_bills WHERE supplier_id = $1 AND supplier_ref = $2 AND kind = 'bill'", [sup.id, input.supplierRef]);
    if (dup) throw unprocessable(`This supplier already has a bill with reference ${input.supplierRef}`);

    const defaultVat = purchaseVatDefault({ vatRegistered: Boolean(sup.vat_number), cisSubcontractor: isSub });
    const lines = input.lines.map((l) => ({ ...l, vatCode: (l.vatCode ?? defaultVat) as VatCode, account: CATEGORY_ACCOUNTS[l.category] }));
    const cisAccount = await roleCode(tx, "cons_cis_liability");
    let posting;
    try {
      posting = postJobBill(await loadRoles(tx), cisAccount, {
        date: input.date, reference: input.supplierRef, cisStatus: isSub ? sup.cis_status as CisStatus : undefined, lines,
      });
    } catch (e) {
      throw unprocessable((e as Error).message);
    }
    const id = newId();
    const number = await nextNumber(tx, ctx, "supplier_bill");
    const entry = await postJournal(tx, ctx, posting, { type: "supplier_bill", id });
    const dueDate = input.dueDate ?? new Date(Date.parse(`${input.date}T00:00:00Z`) + sup.payment_terms_days * 86_400_000).toISOString().slice(0, 10);
    await tx.query(
      `INSERT INTO supplier_bills (id, tenant_id, number, kind, supplier_id, supplier_ref, date, due_date, currency, rate, total, total_gbp, entry_id)
       VALUES ($1,$2,$3,'bill',$4,$5,$6,$7,'GBP',1,$8,$8,$9)`,
      [id, ctx.tenantId, number, sup.id, input.supplierRef, input.date, dueDate, toFixed(posting.total), entry.id]);
    let n = 1;
    for (const l of lines) {
      await tx.query(
        `INSERT INTO supplier_bill_lines (id, tenant_id, bill_id, line_no, kind, account_code, description, net, vat_code, vat)
         VALUES ($1,$2,$3,$4,'account',$5,$6,$7,$8,$9)`,
        [newId(), ctx.tenantId, id, n++, l.account, l.description, l.net, l.vatCode, toFixed(lineVat(l.net, l.vatCode))]);
      await tx.query(
        `INSERT INTO cons_cost_entries (id, tenant_id, project_id, date, category, description, amount, source_type, source_id, entry_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'supplier_bill',$8,$9)`,
        [newId(), ctx.tenantId, proj.id, input.date, l.category, l.description, l.net, id, entry.id]);
    }
    const gross = toFixed(sum(lines.map((l) => l.net)));
    await tx.query(
      `INSERT INTO cons_job_bills (supplier_bill_id, tenant_id, project_id, cis_status, cis_rate, gross, materials, deduction, payable)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, ctx.tenantId, proj.id, posting.cis ? sup.cis_status : null, posting.cis?.rate ?? null, gross,
        posting.cis ? toFixed(posting.cis.materials) : gross, posting.cis ? toFixed(posting.cis.deduction) : "0", toFixed(posting.total)]);
    await audit(tx, ctx, "job_bill.posted", "supplier_bill", id, { number, project: proj.code, deduction: posting.cis ? toFixed(posting.cis.deduction) : "0" });
    return reply.status(201).send({
      id, number, entry: entry.number, payable: toFixed(posting.total),
      cis: posting.cis && { rate: posting.cis.rate, gross: toFixed(posting.cis.gross), materials: toFixed(posting.cis.materials), deduction: toFixed(posting.cis.deduction) },
    });
  }));

  // ---------------------------------------------------------------- applications for payment
  app.get("/api/construction/applications", (req) => inTenant(req, (tx) => tx.query(
    `SELECT a.id, a.reference, a.application_no, a.stage, a.date, a.period_end, a.gross_to_date, a.retention_to_date, a.amount_due, a.vat_code,
            a.vat, a.total, a.final_date, a.pay_less_by, p.code AS project_code, p.name AS project_name, c.name AS customer_name,
            i.number AS invoice_number, i.total - i.amount_paid AS outstanding
       FROM cons_applications a JOIN cons_projects p ON p.id = a.project_id JOIN contacts c ON c.id = p.customer_id
       JOIN sales_invoices i ON i.id = a.sales_invoice_id ORDER BY a.date DESC, a.reference DESC`)));

  app.get("/api/construction/applications/:id", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const [a] = await tx.query<Record<string, unknown> & { project_id: string; vat_code: string }>(
      `SELECT a.*, i.number AS invoice_number, i.total - i.amount_paid AS outstanding FROM cons_applications a
         JOIN sales_invoices i ON i.id = a.sales_invoice_id WHERE a.id = $1`, [id]);
    if (!a) throw notFound("Application");
    const p = await project(tx, a.project_id);
    const [t] = await tx.query("SELECT name, vat_number, company_number, address FROM tenants");
    return { ...a, project: p, supplier: t, reverseCharge: a.vat_code === "RC20" };
  }));

  app.post("/api/construction/projects/:id/applications", (req, reply) => write(req, "finance", async (tx, ctx) => {
    const { id } = IdParams.parse(req.params);
    const input = ApplicationInput.parse(req.body);
    const p = await project(tx, id, true);
    if (p.status === "closed") throw unprocessable("This project is closed");
    const [prev] = await tx.query<{ application_no: number; gross_to_date: string; retention_to_date: string; net_to_date: string; stage: string }>(
      "SELECT application_no, gross_to_date, retention_to_date, net_to_date, stage FROM cons_applications WHERE project_id = $1 ORDER BY application_no DESC LIMIT 1", [id]);
    if (prev?.stage === "final") throw unprocessable("The final account has already been applied for");
    const [tenant] = await tx.query<{ vat_number: string | null }>("SELECT vat_number FROM tenants");
    const customerVat = p.customer_vat_number as string | null;
    let vat;
    let valuation;
    try {
      vat = constructionSalesVat({
        supplierVatRegistered: Boolean(tenant?.vat_number), customerVatRegistered: Boolean(customerVat),
        customerCisRegistered: p.customer_cis_registered, endUserOrIntermediary: p.end_user_notice, rate: p.vat_rate,
        fivePercentDisregard: p.five_percent_disregard,
      });
      valuation = valueApplication({
        grossToDate: input.grossToDate, contractRetentionRate: p.retention_rate, stage: input.stage,
        previous: prev ? { grossToDate: prev.gross_to_date, retentionToDate: prev.retention_to_date, netToDate: prev.net_to_date } : undefined,
      });
    } catch (e) {
      throw unprocessable((e as Error).message);
    }
    const applicationNo = (prev?.application_no ?? 0) + 1;
    const reference = `${p.code}-AFP${String(applicationNo).padStart(2, "0")}`;
    const posting = postApplication(await loadRoles(tx), await roleCode(tx, "cons_retentions"), {
      date: input.date, reference, valuation, vatCode: vat.code,
    });
    const timetable = paymentTimetable(input.periodEnd, input.date, {
      dueDays: p.due_days, finalDays: p.final_days, paymentNoticeDays: p.payment_notice_days, payLessDays: p.pay_less_days,
    });
    const [w] = await tx.query<{ id: string }>("SELECT id FROM warehouses ORDER BY code = 'MAIN' DESC, code LIMIT 1");
    if (!w) throw unprocessable("Create a warehouse first");
    const invoiceId = newId();
    const number = await nextNumber(tx, ctx, "sales_invoice");
    const entry = await postJournal(tx, ctx, posting, { type: "cons_application", id: invoiceId });
    await tx.query(
      `INSERT INTO sales_invoices (id, tenant_id, number, kind, customer_id, warehouse_id, customer_ref, date, due_date, currency, rate, total, total_gbp, entry_id)
       VALUES ($1,$2,$3,'invoice',$4,$5,$6,$7,$8,'GBP',1,$9,$9,$10)`,
      [invoiceId, ctx.tenantId, number, p.customer_id, w.id, reference, input.date, timetable.finalDate, toFixed(posting.total), entry.id]);
    const vatAmount = lineVat(valuation.amountDue, vat.code);
    await tx.query(
      `INSERT INTO sales_invoice_lines (id, tenant_id, invoice_id, line_no, description, quantity, unit_price, net, vat_code, vat, account_code)
       VALUES ($1,$2,$3,1,$4,1,$5,$5,$6,$7,(SELECT code FROM accounts WHERE role = 'sales'))`,
      [newId(), ctx.tenantId, invoiceId, `Application for payment ${applicationNo}: ${p.name}, valuation to ${input.periodEnd}`,
        toFixed(valuation.amountDue), vat.code, toFixed(vatAmount)]);
    const appId = newId();
    await tx.query(
      `INSERT INTO cons_applications (id, tenant_id, project_id, application_no, reference, sales_invoice_id, stage, period_end, date,
         gross_to_date, retention_rate, retention_to_date, net_to_date, previous_net, retention_movement, amount_due, vat_code, vat, total,
         due_date, final_date, payment_notice_by, pay_less_by, entry_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [appId, ctx.tenantId, id, applicationNo, reference, invoiceId, input.stage, input.periodEnd, input.date,
        toFixed(valuation.grossToDate), valuation.retentionRate.toFixed(4), toFixed(valuation.retentionToDate), toFixed(valuation.netToDate),
        prev?.net_to_date ?? "0", toFixed(valuation.retentionMovement), toFixed(valuation.amountDue), vat.code, toFixed(vatAmount),
        toFixed(posting.total), timetable.dueDate, timetable.finalDate, timetable.paymentNoticeBy, timetable.payLessNoticeBy, entry.id]);
    await audit(tx, ctx, "application.posted", "cons_application", appId, { reference, amountDue: toFixed(valuation.amountDue), vat: vat.code });
    return reply.status(201).send({
      id: appId, reference, invoiceNumber: number, amountDue: toFixed(valuation.amountDue), retentionToDate: toFixed(valuation.retentionToDate),
      vatCode: vat.code, vatReason: vat.reason, total: toFixed(posting.total), ...timetable,
    });
  }));

  // ---------------------------------------------------------------- CIS300
  app.get("/api/construction/cis/preview", (req) => inTenant(req, async (tx) => {
    const { monthEnding } = z.object({ monthEnding: z.string() }).parse(req.query);
    const [settings] = await tx.query("SELECT contractor_utr, employer_ref, accounts_office_ref FROM cons_settings");
    const [submitted] = await tx.query("SELECT id, submitted_at, hmrc_receipt FROM cons_cis_returns WHERE tax_month_end = $1", [monthEnding]);
    const [t] = await tx.query<{ name: string }>("SELECT name FROM tenants");
    return { contractor: { name: t?.name, ...(settings ?? {}) }, submitted: submitted ?? null, ...(await cisPreview(tx, monthEnding)) };
  }));

  app.get("/api/construction/cis/returns", (req) => inTenant(req, (tx) => tx.query(
    "SELECT id, tax_month_end, nil, total_deducted, gateway, hmrc_receipt, submitted_at FROM cons_cis_returns ORDER BY tax_month_end DESC")));

  app.post("/api/construction/cis/returns", (req, reply) => write(req, "finance", async (tx, ctx) => {
    const { monthEnding, declarations } = z.object({
      monthEnding: z.string(),
      declarations: z.object({ employmentStatus: z.literal(true), verification: z.literal(true) }),
    }).parse(req.body);
    const [settings] = await tx.query<{ contractor_utr: string | null; employer_ref: string | null }>("SELECT contractor_utr, employer_ref FROM cons_settings");
    if (!settings?.contractor_utr || !settings.employer_ref) throw unprocessable("Add your contractor UTR and employer reference in construction settings first");
    const [dup] = await tx.query("SELECT 1 FROM cons_cis_returns WHERE tax_month_end = $1", [monthEnding]);
    if (dup) throw unprocessable("The return for this tax month has already been submitted");
    const preview = await cisPreview(tx, monthEnding);
    if (preview.statements.some((s) => s.subcontractor.status === "unmatched" && !s.verificationNumber)) {
      throw unprocessable("A subcontractor paid at the unmatched rate has no verification number");
    }
    const receipt = await gateway.submitReturn({ contractorUtr: settings.contractor_utr, employerRef: settings.employer_ref }, preview);
    const id = newId();
    await tx.query(
      `INSERT INTO cons_cis_returns (id, tenant_id, tax_month_end, nil, payload, total_deducted, gateway, hmrc_receipt, submitted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, ctx.tenantId, monthEnding, preview.nil, JSON.stringify({ ...preview, declarations }), preview.totals.amountDeducted, gateway.name,
        JSON.stringify(receipt), ctx.userId]);
    await audit(tx, ctx, "cis_return.submitted", "cons_cis_return", id, { monthEnding, deducted: preview.totals.amountDeducted, gateway: gateway.name });
    return reply.status(201).send({ id, receipt, totals: preview.totals });
  }));

  app.get("/api/construction/integrity", (req) => inTenant(req, (tx) => integrity(tx)));
}
