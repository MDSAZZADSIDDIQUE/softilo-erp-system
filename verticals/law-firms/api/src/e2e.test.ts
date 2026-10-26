import { createPgliteDatabase, newId, type Database } from "@softilo/db";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLawServer, migrateLaw } from "./server.js";

let db: Database;
let app: FastifyInstance;

/** A signed-in client: keeps the session cookie between calls. */
function client() {
  let cookie = "";
  const call = async (method: InjectOptions["method"], url: string, body?: unknown) => {
    const res = await app.inject({ method, url, payload: body as InjectOptions["payload"], headers: cookie ? { cookie } : {} });
    const set = res.headers["set-cookie"];
    if (set) cookie = (Array.isArray(set) ? set[0]! : set).split(";")[0]!;
    const json = res.body ? res.json() : undefined;
    return { status: res.statusCode, body: json };
  };
  const ok = async (method: InjectOptions["method"], url: string, body?: unknown) => {
    const r = await call(method, url, body);
    if (r.status >= 400) throw new Error(`${method} ${url} → ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  return { call, ok };
}

async function balances(c: ReturnType<typeof client>) {
  const accounts = await c.ok("GET", "/api/accounts") as { code: string; balance: string }[];
  return Object.fromEntries(accounts.filter((a) => Number(a.balance) !== 0).map((a) => [a.code, Number(a.balance).toFixed(2)]));
}

async function expectBooksBalance(c: ReturnType<typeof client>) {
  const tb = await c.ok("GET", "/api/reports/trial-balance?asAt=2026-12-31");
  expect(tb.balanced).toBe(true);
}

beforeAll(async () => {
  db = await createPgliteDatabase();
  await migrateLaw(db);
  app = await buildLawServer(db);
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe("law firm vertical slice", () => {
  const c = client();
  const ids: Record<string, string> = {};

  it("signs up a firm and adds the client account to its chart", async () => {
    expect((await c.call("POST", "/api/auth/signup", {
      companyName: "Hartley & Webb LLP", vatNumber: "GB123456789",
      name: "Amara Hartley", email: "amara@hartleywebb.example", password: "correct horse battery",
    })).status).toBe(201);
    const acc = await c.ok("POST", "/api/law/setup", {});
    expect(acc).toMatchObject({ clientBank: "1250", clientControl: "2300", officeBank: "1200", fees: "4010" });
    await c.ok("POST", "/api/law/setup", {}); // idempotent
    const accounts = await c.ok("GET", "/api/accounts") as { code: string; is_control: boolean; is_bank: boolean }[];
    // Client bank is a control account and never a core bank account, so core payments cannot reach it.
    expect(accounts.find((a) => a.code === "1250")).toMatchObject({ is_control: true, is_bank: false });
  });

  it("sets up a fee earner, clients and matters", async () => {
    ids.fe = (await c.ok("POST", "/api/law/fee-earners", { name: "Amara Hartley", initials: "ah", hourlyRate: "250" })).id;
    ids.client = (await c.ok("POST", "/api/law/clients", { name: "Daniel Okafor", clientType: "individual", cddComplete: true })).id;
    ids.client2 = (await c.ok("POST", "/api/law/clients", { name: "Pennine Estates Ltd", clientType: "organisation" })).id;
    const m = await c.ok("POST", "/api/law/matters", { clientId: ids.client, description: "Purchase of 14 Mill Lane", feeEarnerId: ids.fe, openedOn: "2026-09-01" });
    expect(m.number).toBe("MAT-00001");
    ids.matter = m.id;
    ids.matter2 = (await c.ok("POST", "/api/law/matters", { clientId: ids.client2, description: "Lease renewal", feeEarnerId: ids.fe, openedOn: "2026-09-01" })).id;
    expect((await c.call("POST", "/api/law/matters", { clientId: newId(), description: "x", feeEarnerId: ids.fe })).status).toBe(422);
  });

  it("receives client money into the client account against a matter", async () => {
    await c.ok("POST", `/api/law/matters/${ids.matter}/receipts`, { date: "2026-10-01", amount: "25000.00", counterparty: "Daniel Okafor", reference: "Deposit" });
    expect(await balances(c)).toEqual({ "1250": "25000.00", "2300": "-25000.00" });
    await expectBooksBalance(c);
  });

  it("pays out client money but refuses to overdraw the matter's client ledger", async () => {
    await c.ok("POST", `/api/law/matters/${ids.matter}/payments`, { date: "2026-10-02", amount: "4500", counterparty: "HMRC", reference: "SDLT" });
    const over = await c.call("POST", `/api/law/matters/${ids.matter}/payments`, { date: "2026-10-03", amount: "20500.01", counterparty: "Seller's solicitors" });
    expect(over.status).toBe(422);
    expect(over.body.message).toMatch(/overdraw/);
    // Money held on one matter can never fund another.
    expect((await c.call("POST", `/api/law/matters/${ids.matter2}/payments`, { date: "2026-10-03", amount: "1", counterparty: "Landlord" })).status).toBe(422);
    expect(await balances(c)).toEqual({ "1250": "20500.00", "2300": "-20500.00" });
  });

  it("refuses a back-dated payment that would have overdrawn the ledger on its date", async () => {
    await c.ok("POST", `/api/law/matters/${ids.matter2}/receipts`, { date: "2026-10-05", amount: "1000", counterparty: "Pennine Estates Ltd" });
    expect((await c.call("POST", `/api/law/matters/${ids.matter2}/payments`, { date: "2026-10-04", amount: "500", counterparty: "Landlord" })).status).toBe(422);
    await c.ok("POST", `/api/law/matters/${ids.matter2}/payments`, { date: "2026-10-06", amount: "400", counterparty: "Landlord's agent" });
  });

  it("records time in six-minute units and bills it on a fee note with VAT", async () => {
    expect((await c.ok("POST", `/api/law/matters/${ids.matter}/time`, { date: "2026-10-07", minutes: 60, narrative: "Review title and searches" })).value).toBe("250.00");
    expect((await c.ok("POST", `/api/law/matters/${ids.matter}/time`, { date: "2026-10-08", minutes: 13, narrative: "Call with client" })).value).toBe("75.00");
    expect((await c.call("POST", `/api/law/matters/${ids.matter}/time`, { date: "2026-10-08", minutes: 0, narrative: "x" })).status).toBe(422);
    const overview = await c.ok("GET", "/api/law/overview");
    expect(overview).toMatchObject({ wip: "325.00", clientMoney: "21100.00", openMatters: 2 });

    const fn = await c.ok("POST", `/api/law/matters/${ids.matter}/fee-notes`, { date: "2026-10-10" });
    expect(fn).toMatchObject({ number: "FN-00001", net: "325.00", vat: "65.00", total: "390.00" });
    ids.feeNote = fn.id;
    expect(await balances(c)).toMatchObject({ "1100": "390.00", "4010": "-325.00", "2200": "-65.00" });
    expect((await c.call("POST", `/api/law/matters/${ids.matter}/fee-notes`, { date: "2026-10-10" })).status).toBe(422);
    const vat = await c.ok("GET", "/api/vat/returns/preview?from=2026-10-01&to=2026-12-31").catch(() => null);
    if (vat) expect(vat.boxes?.box1 ?? vat.box1).toBe("65.00");
    await expectBooksBalance(c);
  });

  it("transfers client money to office to settle the fee note, within the rules", async () => {
    expect((await c.call("POST", `/api/law/fee-notes/${ids.feeNote}/transfer`, { date: "2026-10-09", amount: "390" })).status).toBe(422); // before the bill
    expect((await c.call("POST", `/api/law/fee-notes/${ids.feeNote}/transfer`, { date: "2026-10-11", amount: "390.01" })).status).toBe(422); // more than billed
    await c.ok("POST", `/api/law/fee-notes/${ids.feeNote}/transfer`, { date: "2026-10-11", amount: "390" });
    expect((await c.call("POST", `/api/law/fee-notes/${ids.feeNote}/transfer`, { date: "2026-10-11", amount: "0.01" })).status).toBe(422); // already settled
    expect(await balances(c)).toEqual({
      "1200": "390.00", "1250": "20710.00", "2300": "-20710.00", "4010": "-325.00", "2200": "-65.00",
    });
    const detail = await c.ok("GET", `/api/law/matters/${ids.matter}`);
    expect(detail).toMatchObject({ clientBalance: "20110.00", officeBalance: "0.00" });
    expect(detail.feeNotes[0]).toMatchObject({ outstanding: "0.00", amount_settled: "390.00" });
    expect(detail.time.every((t: { fee_note_number: string }) => t.fee_note_number === "FN-00001")).toBe(true);
    expect(detail.clientLedger.map((e: { balance: string }) => e.balance)).toEqual(["25000.00", "20500.00", "20110.00"]);
    await expectBooksBalance(c);
  });

  it("produces a three-way reconciliation and has it signed off", async () => {
    // The statement still shows £21,110: the £400 cheque to the landlord's agent has not been presented yet.
    const input = {
      statementDate: "2026-10-31", statementBalance: "21110.00",
      outstandingLodgements: [], unpresentedPayments: [{ reference: "CHQ 100231", amount: "400.00" }],
    };
    const preview = await c.ok("POST", "/api/law/reconciliations/preview", input);
    expect(preview).toMatchObject({
      adjustedBank: "20710.00", cashBook: "20710.00", clientLedgers: "20710.00", clientControl: "20710.00", balanced: true,
      nextDue: "2026-12-05",
    });
    expect(preview.matters).toHaveLength(2);
    const wrong = await c.ok("POST", "/api/law/reconciliations/preview", { ...input, statementBalance: "21100.00" });
    expect(wrong).toMatchObject({ balanced: false, differences: { bankVsCashBook: "-10.00" } });

    const saved = await c.ok("POST", "/api/law/reconciliations", input);
    await c.ok("POST", `/api/law/reconciliations/${saved.id}/sign-off`, { note: "Checked by COFA" });
    expect((await c.call("POST", `/api/law/reconciliations/${saved.id}/sign-off`, {})).status).toBe(422);
    const unbalanced = await c.ok("POST", "/api/law/reconciliations", { ...input, statementBalance: "21100.00" });
    expect((await c.call("POST", `/api/law/reconciliations/${unbalanced.id}/sign-off`, {})).status).toBe(422);
    const list = await c.ok("GET", "/api/law/reconciliations");
    expect(list.nextDue).toBe("2026-12-05");
    expect(list.rows.find((r: { id: string }) => r.id === saved.id)).toMatchObject({ signed_off_by_name: "Amara Hartley" });
  });

  it("blocks manual journals on client money accounts", async () => {
    const r = await c.call("POST", "/api/journals", { date: "2026-10-20", memo: "Borrow from client account",
      lines: [{ accountCode: "1200", debit: "100" }, { accountCode: "1250", credit: "100" }] });
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/control account/);
  });

  it("enforces the rules in the database even if the app is bypassed", async () => {
    const me = await c.ok("GET", "/api/auth/me");
    const tenant = me.tenant_id as string;
    const [entry] = await db.tenant(tenant, (tx) => tx.query<{ id: string }>("SELECT id FROM journal_entries LIMIT 1"));
    await expect(db.tenant(tenant, (tx) => tx.query(
      `INSERT INTO law_ledger_entries (id, tenant_id, matter_id, entry_id, date, side, kind, amount)
       VALUES ($1,$2,$3,$4,'2026-10-20','client','payment',-20110.01)`, [newId(), tenant, ids.matter, entry!.id])))
      .rejects.toThrow(/overdrawn/);
    await expect(db.tenant(tenant, (tx) => tx.query("UPDATE law_ledger_entries SET amount = 1"))).rejects.toThrow();
    await expect(db.tenant(tenant, (tx) => tx.query("UPDATE law_time_entries SET value = 1"))).rejects.toThrow(/billed/);
    await expect(db.tenant(tenant, (tx) => tx.query("UPDATE law_fee_notes SET total = 1"))).rejects.toThrow();
    await expect(db.tenant(tenant, (tx) => tx.query("UPDATE law_reconciliations SET statement_balance = 0"))).rejects.toThrow(/signed off/);
  });

  it("keeps each firm's matters private", async () => {
    const other = client();
    await other.ok("POST", "/api/auth/signup", {
      companyName: "Other Firm LLP", name: "Sam Lee", email: "sam@other.example", password: "correct horse battery",
    });
    expect(await other.ok("GET", "/api/law/matters")).toEqual([]);
    expect((await other.call("GET", `/api/law/matters/${ids.matter}`)).status).toBe(404);
    expect((await other.call("POST", `/api/law/matters/${ids.matter}/receipts`, { date: "2026-10-01", amount: "1", counterparty: "x" })).status).toBe(404);
    const rows = await db.tenant(newId(), (tx) => tx.query("SELECT * FROM law_ledger_entries"));
    expect(rows).toEqual([]);
  });
});
