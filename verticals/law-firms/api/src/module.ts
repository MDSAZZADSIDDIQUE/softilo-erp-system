import { newId, type Sql } from "@softilo/db";
import { d, round2, sum, toFixed, type Dec } from "@softilo/domain";
import {
  checkTransfer, ClientLedgerOverdrawnError, InvalidTimeError, LAW_CHART, maxTransfer, nextReconciliationDue,
  postClientPayment, postClientReceipt, postClientToOffice, postFeeNote, threeWayReconciliation, timeUnits, timeValue,
  TransferNotAllowedError, withdrawClientMoney, type LawAccounts,
} from "@softilo-law/domain";
import { inTenant, requireWrite, type Ctx } from "@softilo/api/lib/context";
import { notFound, unprocessable } from "@softilo/api/lib/errors";
import { audit, postJournal } from "@softilo/api/lib/ledger";
import { IdParams, isoDate, positiveMoney, money, today, uuid, vatCode } from "@softilo/api/lib/schemas";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

/** Domain refusals (overdrawn ledger, transfer too large, bad time) become 422s with the rule's message. */
function refuse<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ClientLedgerOverdrawnError || e instanceof TransferNotAllowedError
      || e instanceof InvalidTimeError || e instanceof RangeError) throw unprocessable(e.message);
    throw e;
  }
}

const SEQUENCES = { law_matter: "MAT", law_fee_note: "FN" } as const;

async function nextNumber(tx: Sql, ctx: Ctx, kind: keyof typeof SEQUENCES): Promise<string> {
  const [row] = await tx.query<{ value: string }>(
    `INSERT INTO number_sequences (tenant_id, kind, prefix, next_value) VALUES ($1, $2, $3, 2)
     ON CONFLICT (tenant_id, kind) DO UPDATE SET next_value = number_sequences.next_value + 1
     RETURNING next_value - 1 AS value`,
    [ctx.tenantId, kind, SEQUENCES[kind]],
  );
  return `${SEQUENCES[kind]}-${String(row!.value).padStart(5, "0")}`;
}

/** Add the law-firm accounts to the tenant's chart (idempotent) and return the codes the postings use. */
export async function ensureLawAccounts(tx: Sql, ctx: Ctx): Promise<LawAccounts> {
  for (const a of LAW_CHART) {
    await tx.query(
      `INSERT INTO accounts (tenant_id, code, name, type, role, is_control, is_bank) VALUES ($1,$2,$3,$4,$5,$6,false)
       ON CONFLICT DO NOTHING`,
      [ctx.tenantId, a.code, a.name, a.type, a.role, a.control],
    );
  }
  const rows = await tx.query<{ role: string; code: string }>("SELECT role, code FROM accounts WHERE role IS NOT NULL");
  const r = Object.fromEntries(rows.map((x) => [x.role, x.code]));
  for (const role of ["client_bank", "client_control", "fees", "bank", "debtors", "vat_output"]) {
    if (!r[role]) throw unprocessable(`The chart of accounts has no ${role.replace("_", " ")} account`);
  }
  return {
    clientBank: r.client_bank!, clientControl: r.client_control!, fees: r.fees!,
    officeBank: r.bank!, debtors: r.debtors!, vatOutput: r.vat_output!,
  };
}

async function lawAccountsIfSetUp(tx: Sql): Promise<{ clientBank?: string; clientControl?: string }> {
  const rows = await tx.query<{ role: string; code: string }>(
    "SELECT role, code FROM accounts WHERE role IN ('client_bank','client_control')");
  const r = Object.fromEntries(rows.map((x) => [x.role, x.code]));
  return { clientBank: r.client_bank, clientControl: r.client_control };
}

type MatterRow = { id: string; number: string; status: string; client_id: string; fee_earner_id: string };

async function loadMatter(tx: Sql, id: string, lock = false): Promise<MatterRow> {
  const [m] = await tx.query<MatterRow>(
    `SELECT id, number, status, client_id, fee_earner_id FROM law_matters WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`, [id]);
  if (!m) throw notFound("Matter");
  return m;
}

function requireOpen(m: MatterRow) {
  if (m.status !== "open") throw unprocessable(`Matter ${m.number} is closed`);
}

/**
 * The most that can leave a matter's client ledger on `date` without overdrawing it on that date
 * or any later one: the lowest running balance from `date` onwards.
 */
async function clientAvailable(tx: Sql, matterId: string, date: string): Promise<Dec> {
  const rows = await tx.query<{ date: string; amount: string }>(
    "SELECT date, sum(amount) AS amount FROM law_ledger_entries WHERE matter_id = $1 AND side = 'client' GROUP BY date ORDER BY date",
    [matterId]);
  let running = d(0);
  let low: Dec | undefined;
  for (const r of rows) {
    running = running.plus(r.amount);
    if (r.date >= date && (low === undefined || running.lessThan(low))) low = running;
  }
  const atDate = sum(rows.filter((r) => r.date <= date).map((r) => d(r.amount)));
  return low === undefined || atDate.lessThan(low) ? atDate : low;
}

async function writeLedger(tx: Sql, ctx: Ctx, row: {
  matterId: string; entryId: string; date: string; side: "client" | "office";
  kind: "receipt" | "payment" | "transfer" | "fee_note"; amount: Dec;
  counterparty?: string | null; reference?: string | null; feeNoteId?: string | null;
}) {
  await tx.query(
    `INSERT INTO law_ledger_entries (id, tenant_id, matter_id, entry_id, date, side, kind, amount, counterparty, reference, fee_note_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [newId(), ctx.tenantId, row.matterId, row.entryId, row.date, row.side, row.kind, toFixed(row.amount),
      row.counterparty ?? null, row.reference ?? null, row.feeNoteId ?? null, ctx.userId]);
}

/** GL balance (debit − credit) of an account up to and including a date. */
async function glBalance(tx: Sql, code: string | undefined, asAt: string): Promise<Dec> {
  if (!code) return d(0);
  const [r] = await tx.query<{ balance: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0) AS balance FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_code = $1 AND e.date <= $2`, [code, asAt]);
  return d(r!.balance);
}

const MoneyMovement = z.object({
  date: isoDate,
  amount: positiveMoney,
  counterparty: z.string().trim().min(1).max(160),
  reference: z.string().trim().max(100).optional(),
});

const OutstandingItem = z.object({ reference: z.string().trim().max(100).default(""), amount: positiveMoney });
const ReconciliationInput = z.object({
  statementDate: isoDate,
  statementBalance: money,
  outstandingLodgements: z.array(OutstandingItem).max(500).default([]),
  unpresentedPayments: z.array(OutstandingItem).max(500).default([]),
});

async function reconcile(tx: Sql, input: z.infer<typeof ReconciliationInput>) {
  const acc = await lawAccountsIfSetUp(tx);
  const matters = await tx.query<{ id: string; number: string; description: string; client_name: string; balance: string }>(
    `SELECT m.id, m.number, m.description, c.name AS client_name, sum(l.amount) AS balance
       FROM law_ledger_entries l JOIN law_matters m ON m.id = l.matter_id JOIN contacts c ON c.id = m.client_id
      WHERE l.side = 'client' AND l.date <= $1
      GROUP BY m.id, m.number, m.description, c.name HAVING sum(l.amount) <> 0 ORDER BY m.number`, [input.statementDate]);
  const result = threeWayReconciliation({
    statementBalance: input.statementBalance,
    outstandingLodgements: input.outstandingLodgements.map((i) => i.amount),
    unpresentedPayments: input.unpresentedPayments.map((i) => i.amount),
    cashBook: await glBalance(tx, acc.clientBank, input.statementDate),
    // Client money held is a credit balance; show it as a positive figure.
    clientControl: (await glBalance(tx, acc.clientControl, input.statementDate)).neg(),
    matterBalances: matters.map((m) => ({ matterId: m.id, balance: m.balance })),
  });
  const f = (v: Dec) => v.toFixed(2);
  return {
    statementDate: input.statementDate,
    statementBalance: f(result.statementBalance),
    outstandingLodgements: f(result.outstandingLodgements),
    unpresentedPayments: f(result.unpresentedPayments),
    adjustedBank: f(result.adjustedBank),
    cashBook: f(result.cashBook),
    clientLedgers: f(result.clientLedgers),
    clientControl: f(result.clientControl),
    differences: {
      bankVsCashBook: f(result.differences.bankVsCashBook),
      cashBookVsLedgers: f(result.differences.cashBookVsLedgers),
      ledgersVsControl: f(result.differences.ledgersVsControl),
    },
    overdrawn: result.overdrawn.map((o) => o.matterId),
    balanced: result.balanced,
    matters: matters.map((m) => ({ ...m, balance: d(m.balance).toFixed(2) })),
    items: { outstandingLodgements: input.outstandingLodgements, unpresentedPayments: input.unpresentedPayments },
    nextDue: nextReconciliationDue(input.statementDate),
  };
}

export async function registerLaw(app: FastifyInstance) {
  app.post("/api/law/setup", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "settings");
    return ensureLawAccounts(tx, ctx);
  }));

  // ---------------------------------------------------------------- overview
  app.get("/api/law/overview", (req) => inTenant(req, async (tx) => {
    const [t] = await tx.query<{ client_money: string; office_owed: string; wip: string; open_matters: string }>(
      `SELECT coalesce((SELECT sum(amount) FROM law_ledger_entries WHERE side = 'client'), 0) AS client_money,
              coalesce((SELECT sum(amount) FROM law_ledger_entries WHERE side = 'office'), 0) AS office_owed,
              coalesce((SELECT sum(value) FROM law_time_entries WHERE fee_note_id IS NULL), 0) AS wip,
              (SELECT count(*) FROM law_matters WHERE status = 'open') AS open_matters`);
    const [last] = await tx.query<{ statement_date: string; balanced: boolean; signed_off_at: string | null }>(
      "SELECT statement_date, balanced, signed_off_at FROM law_reconciliations ORDER BY statement_date DESC, prepared_at DESC LIMIT 1");
    return {
      clientMoney: d(t!.client_money).toFixed(2),
      officeOwed: d(t!.office_owed).toFixed(2),
      wip: d(t!.wip).toFixed(2),
      openMatters: Number(t!.open_matters),
      lastReconciliation: last ?? null,
      nextReconciliationDue: last ? nextReconciliationDue(last.statement_date) : null,
    };
  }));

  // ---------------------------------------------------------------- fee earners
  app.get("/api/law/fee-earners", (req) => inTenant(req, (tx) =>
    tx.query("SELECT * FROM law_fee_earners WHERE NOT archived ORDER BY name")));

  app.post("/api/law/fee-earners", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "settings");
    const b = z.object({
      name: z.string().trim().min(1).max(120),
      initials: z.string().trim().min(1).max(6).transform((s) => s.toUpperCase()),
      hourlyRate: money.refine((v) => Number(v) >= 0, "Cannot be negative"),
    }).parse(req.body);
    const id = newId();
    await tx.query("INSERT INTO law_fee_earners (id, tenant_id, name, initials, hourly_rate) VALUES ($1,$2,$3,$4,$5)",
      [id, ctx.tenantId, b.name, b.initials, b.hourlyRate]);
    await audit(tx, ctx, "law.fee_earner.created", "law_fee_earner", id, b);
    return reply.status(201).send({ id });
  }));

  // ---------------------------------------------------------------- clients
  app.get("/api/law/clients", (req) => inTenant(req, (tx) => tx.query(
    `SELECT c.id, c.name, c.email, c.phone, lc.client_type, lc.cdd_status,
            (SELECT count(*) FROM law_matters m WHERE m.client_id = c.id) AS matters,
            coalesce((SELECT sum(l.amount) FROM law_ledger_entries l JOIN law_matters m ON m.id = l.matter_id
                       WHERE m.client_id = c.id AND l.side = 'client'), 0) AS client_balance
       FROM law_clients lc JOIN contacts c ON c.id = lc.contact_id ORDER BY c.name`)));

  app.post("/api/law/clients", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const b = z.object({
      name: z.string().trim().min(1).max(160),
      clientType: z.enum(["individual", "organisation"]),
      email: z.email().optional().or(z.literal("")),
      phone: z.string().trim().max(40).optional(),
      cddComplete: z.boolean().default(false),
    }).parse(req.body);
    const id = newId();
    await tx.query("INSERT INTO contacts (id, tenant_id, kind, name, email, phone) VALUES ($1,$2,'customer',$3,$4,$5)",
      [id, ctx.tenantId, b.name, b.email || null, b.phone || null]);
    await tx.query("INSERT INTO law_clients (contact_id, tenant_id, client_type, cdd_status) VALUES ($1,$2,$3,$4)",
      [id, ctx.tenantId, b.clientType, b.cddComplete ? "complete" : "pending"]);
    await audit(tx, ctx, "law.client.created", "contact", id, b);
    return reply.status(201).send({ id });
  }));

  // ---------------------------------------------------------------- matters
  app.get("/api/law/matters", (req) => inTenant(req, async (tx) => {
    const q = z.object({ status: z.enum(["open", "closed"]).optional(), clientId: uuid.optional() }).parse(req.query);
    return tx.query(
      `SELECT m.id, m.number, m.description, m.status, m.opened_on, c.name AS client_name, f.initials AS fee_earner,
              coalesce((SELECT sum(amount) FROM law_ledger_entries l WHERE l.matter_id = m.id AND l.side = 'client'), 0) AS client_balance,
              coalesce((SELECT sum(amount) FROM law_ledger_entries l WHERE l.matter_id = m.id AND l.side = 'office'), 0) AS office_balance,
              coalesce((SELECT sum(value) FROM law_time_entries t WHERE t.matter_id = m.id AND t.fee_note_id IS NULL), 0) AS wip
         FROM law_matters m JOIN contacts c ON c.id = m.client_id JOIN law_fee_earners f ON f.id = m.fee_earner_id
        WHERE ($1::text IS NULL OR m.status = $1) AND ($2::uuid IS NULL OR m.client_id = $2)
        ORDER BY m.number DESC`, [q.status ?? null, q.clientId ?? null]);
  }));

  app.post("/api/law/matters", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const b = z.object({
      clientId: uuid,
      description: z.string().trim().min(1).max(200),
      feeEarnerId: uuid,
      openedOn: isoDate.default(today),
    }).parse(req.body);
    await ensureLawAccounts(tx, ctx);
    const [client] = await tx.query("SELECT 1 FROM law_clients WHERE contact_id = $1", [b.clientId]);
    if (!client) throw unprocessable("Client not found");
    const [fe] = await tx.query("SELECT 1 FROM law_fee_earners WHERE id = $1 AND NOT archived", [b.feeEarnerId]);
    if (!fe) throw unprocessable("Fee earner not found");
    const id = newId();
    const number = await nextNumber(tx, ctx, "law_matter");
    await tx.query(
      `INSERT INTO law_matters (id, tenant_id, number, client_id, description, fee_earner_id, opened_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, ctx.tenantId, number, b.clientId, b.description, b.feeEarnerId, b.openedOn]);
    await audit(tx, ctx, "law.matter.opened", "law_matter", id, { number, ...b });
    return reply.status(201).send({ id, number });
  }));

  app.get("/api/law/matters/:id", (req) => inTenant(req, async (tx) => {
    const { id } = IdParams.parse(req.params);
    const [matter] = await tx.query(
      `SELECT m.*, c.name AS client_name, lc.client_type, lc.cdd_status, f.name AS fee_earner_name, f.initials AS fee_earner,
              f.hourly_rate
         FROM law_matters m JOIN contacts c ON c.id = m.client_id JOIN law_clients lc ON lc.contact_id = m.client_id
         JOIN law_fee_earners f ON f.id = m.fee_earner_id WHERE m.id = $1`, [id]);
    if (!matter) throw notFound("Matter");
    const entries = await tx.query<{ side: string; amount: string } & Record<string, unknown>>(
      `SELECT l.id, l.date, l.side, l.kind, l.amount, l.counterparty, l.reference, e.number AS journal_number, n.number AS fee_note_number
         FROM law_ledger_entries l JOIN journal_entries e ON e.id = l.entry_id LEFT JOIN law_fee_notes n ON n.id = l.fee_note_id
        WHERE l.matter_id = $1 ORDER BY l.date, l.created_at`, [id]);
    const running = { client: d(0), office: d(0) };
    const withBalance = (side: "client" | "office") => entries.filter((e) => e.side === side).map((e) => {
      running[side] = running[side].plus(e.amount);
      return { ...e, balance: running[side].toFixed(2) };
    });
    const client = withBalance("client");
    const office = withBalance("office");
    const time = await tx.query(
      `SELECT t.*, f.initials AS fee_earner, n.number AS fee_note_number FROM law_time_entries t
         JOIN law_fee_earners f ON f.id = t.fee_earner_id LEFT JOIN law_fee_notes n ON n.id = t.fee_note_id
        WHERE t.matter_id = $1 ORDER BY t.date, t.created_at`, [id]);
    const feeNotes = await tx.query<{ total: string; amount_settled: string } & Record<string, unknown>>(
      "SELECT * FROM law_fee_notes WHERE matter_id = $1 ORDER BY date, number", [id]);
    return {
      matter,
      clientBalance: running.client.toFixed(2),
      officeBalance: running.office.toFixed(2),
      clientLedger: client,
      officeLedger: office,
      time,
      feeNotes: feeNotes.map((n) => {
        const outstanding = d(n.total).minus(n.amount_settled);
        return { ...n, outstanding: outstanding.toFixed(2), maxTransfer: maxTransfer(running.client, outstanding).toFixed(2) };
      }),
    };
  }));

  // ---------------------------------------------------------------- client money
  app.post("/api/law/matters/:id/receipts", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const { id } = IdParams.parse(req.params);
    const b = MoneyMovement.parse(req.body);
    const acc = await ensureLawAccounts(tx, ctx);
    const m = await loadMatter(tx, id, true);
    requireOpen(m);
    const amount = round2(b.amount);
    const posting = postClientReceipt(acc, { date: b.date, matter: m.number, reference: b.reference ?? b.counterparty, amount });
    const entry = await postJournal(tx, ctx, posting, { type: "law_client_receipt", id });
    await writeLedger(tx, ctx, { matterId: id, entryId: entry.id, date: b.date, side: "client", kind: "receipt", amount,
      counterparty: b.counterparty, reference: b.reference });
    await audit(tx, ctx, "law.client.receipt", "law_matter", id, { ...b, journal: entry.number });
    return reply.status(201).send({ journal: entry.number });
  }));

  app.post("/api/law/matters/:id/payments", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const { id } = IdParams.parse(req.params);
    const b = MoneyMovement.parse(req.body);
    const acc = await ensureLawAccounts(tx, ctx);
    const m = await loadMatter(tx, id, true);
    const available = await clientAvailable(tx, id, b.date);
    const amount = refuse(() => { withdrawClientMoney(available, b.amount); return round2(b.amount); });
    const posting = postClientPayment(acc, { date: b.date, matter: m.number, reference: b.reference ?? b.counterparty, amount });
    const entry = await postJournal(tx, ctx, posting, { type: "law_client_payment", id });
    await writeLedger(tx, ctx, { matterId: id, entryId: entry.id, date: b.date, side: "client", kind: "payment", amount: amount.neg(),
      counterparty: b.counterparty, reference: b.reference });
    await audit(tx, ctx, "law.client.payment", "law_matter", id, { ...b, journal: entry.number });
    return reply.status(201).send({ journal: entry.number });
  }));

  // ---------------------------------------------------------------- time and billing
  app.post("/api/law/matters/:id/time", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "operations");
    const { id } = IdParams.parse(req.params);
    const b = z.object({
      date: isoDate,
      minutes: z.number().int(),
      narrative: z.string().trim().min(1).max(500),
      feeEarnerId: uuid.optional(),
      rate: money.optional(),
    }).parse(req.body);
    const m = await loadMatter(tx, id);
    requireOpen(m);
    const feeEarnerId = b.feeEarnerId ?? m.fee_earner_id;
    const [fe] = await tx.query<{ hourly_rate: string }>("SELECT hourly_rate FROM law_fee_earners WHERE id = $1", [feeEarnerId]);
    if (!fe) throw unprocessable("Fee earner not found");
    const rate = b.rate ?? fe.hourly_rate;
    const { units, value } = refuse(() => ({ units: timeUnits(b.minutes), value: timeValue(b.minutes, rate) }));
    const entryId = newId();
    await tx.query(
      `INSERT INTO law_time_entries (id, tenant_id, matter_id, fee_earner_id, date, minutes, units, rate, value, narrative, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [entryId, ctx.tenantId, id, feeEarnerId, b.date, b.minutes, units, toFixed(rate), toFixed(value), b.narrative, ctx.userId]);
    return reply.status(201).send({ id: entryId, units, value: value.toFixed(2) });
  }));

  app.post("/api/law/matters/:id/fee-notes", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const { id } = IdParams.parse(req.params);
    const b = z.object({
      date: isoDate,
      timeEntryIds: z.array(uuid).max(1000).optional(),
      vatCode: vatCode.default("S20"),
    }).parse(req.body);
    const acc = await ensureLawAccounts(tx, ctx);
    const m = await loadMatter(tx, id, true);
    const time = await tx.query<{ id: string; value: string }>(
      `SELECT id, value FROM law_time_entries WHERE matter_id = $1 AND fee_note_id IS NULL
          AND ($2::uuid[] IS NULL OR id = ANY($2)) ORDER BY date FOR UPDATE`, [id, b.timeEntryIds ?? null]);
    if (!time.length) throw unprocessable("There is no unbilled time to bill on this matter");
    if (b.timeEntryIds && time.length !== new Set(b.timeEntryIds).size) throw unprocessable("Some time entries are already billed or belong to another matter");
    const number = await nextNumber(tx, ctx, "law_fee_note");
    const posting = refuse(() => postFeeNote(acc, { date: b.date, number, matter: m.number, vatCode: b.vatCode, lines: time.map((t) => ({ net: t.value })) }));
    const feeNoteId = newId();
    const entry = await postJournal(tx, ctx, posting, { type: "law_fee_note", id: feeNoteId });
    await tx.query(
      `INSERT INTO law_fee_notes (id, tenant_id, number, matter_id, date, vat_code, net, vat, total, entry_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [feeNoteId, ctx.tenantId, number, id, b.date, b.vatCode, toFixed(posting.net), toFixed(posting.vatAmount), toFixed(posting.total), entry.id, ctx.userId]);
    await tx.query("UPDATE law_time_entries SET fee_note_id = $1 WHERE id = ANY($2)", [feeNoteId, time.map((t) => t.id)]);
    await writeLedger(tx, ctx, { matterId: id, entryId: entry.id, date: b.date, side: "office", kind: "fee_note", amount: posting.total,
      reference: number, feeNoteId });
    await audit(tx, ctx, "law.fee_note.issued", "law_fee_note", feeNoteId, { number, matter: m.number, total: posting.total.toFixed(2) });
    return reply.status(201).send({ id: feeNoteId, number, net: posting.net.toFixed(2), vat: posting.vatAmount.toFixed(2), total: posting.total.toFixed(2) });
  }));

  app.post("/api/law/fee-notes/:id/transfer", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const { id } = IdParams.parse(req.params);
    const b = z.object({ date: isoDate, amount: positiveMoney }).parse(req.body);
    const acc = await ensureLawAccounts(tx, ctx);
    const [note] = await tx.query<{ number: string; matter_id: string; total: string; amount_settled: string; date: string }>(
      "SELECT number, matter_id, total, amount_settled, date FROM law_fee_notes WHERE id = $1 FOR UPDATE", [id]);
    if (!note) throw notFound("Fee note");
    // Rule 4.3: the bill must come first.
    if (b.date < note.date) throw unprocessable("Costs cannot be transferred before the fee note is dated");
    const m = await loadMatter(tx, note.matter_id, true);
    const available = await clientAvailable(tx, m.id, b.date);
    const amount = refuse(() => checkTransfer({
      clientBalance: available, feeNoteOutstanding: d(note.total).minus(note.amount_settled), amount: b.amount,
    }));
    const posting = postClientToOffice(acc, { date: b.date, matter: m.number, feeNote: note.number, amount });
    const entry = await postJournal(tx, ctx, posting, { type: "law_transfer", id });
    for (const side of ["client", "office"] as const) {
      await writeLedger(tx, ctx, { matterId: m.id, entryId: entry.id, date: b.date, side, kind: "transfer", amount: amount.neg(),
        reference: note.number, feeNoteId: id });
    }
    await tx.query("UPDATE law_fee_notes SET amount_settled = amount_settled + $2 WHERE id = $1", [id, toFixed(amount)]);
    await audit(tx, ctx, "law.transfer.client_to_office", "law_fee_note", id, { amount: amount.toFixed(2), journal: entry.number });
    return reply.status(201).send({ journal: entry.number });
  }));

  // ---------------------------------------------------------------- three-way reconciliation
  app.post("/api/law/reconciliations/preview", (req) => inTenant(req, (tx) => reconcile(tx, ReconciliationInput.parse(req.body))));

  app.get("/api/law/reconciliations", (req) => inTenant(req, async (tx) => {
    const rows = await tx.query<{ statement_date: string } & Record<string, unknown>>(
      `SELECT r.*, p.name AS prepared_by_name, s.name AS signed_off_by_name FROM law_reconciliations r
         JOIN users p ON p.id = r.prepared_by LEFT JOIN users s ON s.id = r.signed_off_by
        ORDER BY r.statement_date DESC, r.prepared_at DESC`);
    return { rows, nextDue: rows[0] ? nextReconciliationDue(rows[0].statement_date) : null };
  }));

  app.post("/api/law/reconciliations", (req, reply) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "finance");
    const r = await reconcile(tx, ReconciliationInput.parse(req.body));
    const id = newId();
    await tx.query(
      `INSERT INTO law_reconciliations (id, tenant_id, statement_date, statement_balance, outstanding_lodgements, unpresented_payments,
         adjusted_bank, cash_book, client_ledgers, client_control, overdrawn_matters, balanced, prepared_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, ctx.tenantId, r.statementDate, r.statementBalance, JSON.stringify(r.items.outstandingLodgements),
        JSON.stringify(r.items.unpresentedPayments), r.adjustedBank, r.cashBook, r.clientLedgers, r.clientControl,
        r.overdrawn.length, r.balanced, ctx.userId]);
    await audit(tx, ctx, "law.reconciliation.prepared", "law_reconciliation", id, { statementDate: r.statementDate, balanced: r.balanced });
    return reply.status(201).send({ id, ...r });
  }));

  /** Rule 8.3: the COFA or a manager signs off each reconciliation. Owners and admins are the firm's managers here. */
  app.post("/api/law/reconciliations/:id/sign-off", (req) => inTenant(req, async (tx, ctx) => {
    requireWrite(ctx, "settings");
    const { id } = IdParams.parse(req.params);
    const b = z.object({ note: z.string().trim().max(1000).optional() }).parse(req.body ?? {});
    const [rec] = await tx.query<{ balanced: boolean; signed_off_at: string | null }>(
      "SELECT balanced, signed_off_at FROM law_reconciliations WHERE id = $1 FOR UPDATE", [id]);
    if (!rec) throw notFound("Reconciliation");
    if (rec.signed_off_at) throw unprocessable("This reconciliation has already been signed off");
    if (!rec.balanced && !b.note) throw unprocessable("This reconciliation does not balance: add a note explaining the differences and what is being done");
    await tx.query("UPDATE law_reconciliations SET signed_off_by = $2, signed_off_at = now(), sign_off_note = $3 WHERE id = $1",
      [id, ctx.userId, b.note ?? null]);
    await audit(tx, ctx, "law.reconciliation.signed_off", "law_reconciliation", id, b);
    return { ok: true };
  }));
}
