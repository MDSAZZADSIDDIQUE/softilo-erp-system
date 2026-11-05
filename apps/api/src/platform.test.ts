import { createPgliteDatabase, migrate, type Database } from "@softilo/db";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rulesExtract } from "./integrations/ai.js";
import { demoBankLines } from "./integrations/bank-feed.js";
import { quarterlyPeriods, validateBoxes } from "./integrations/hmrc.js";
import { createProviders } from "./integrations/index.js";
import { vatChecksumOk } from "./integrations/services.js";
import { addDays, today } from "./lib/schemas.js";
import { base32Encode, hotp, step, verifyTotp } from "./lib/totp.js";
import { buildServer } from "./server.js";

describe("building blocks", () => {
  it("generates RFC 6238 codes", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(secret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(hotp(secret, 1)).toBe("287082"); // T = 59s
    expect(hotp(secret, Math.floor(1111111109 / 30))).toBe("081804");
    const s = step(1111111109_000);
    expect(verifyTotp(secret, "081804", null, 1111111109_000)).toBe(s);
    expect(verifyTotp(secret, "081804", s, 1111111109_000)).toBeNull(); // no replay
  });

  it("checks UK VAT numbers the way HMRC does", () => {
    expect(vatChecksumOk("GB193847518")).toBe(true);
    expect(vatChecksumOk("193847519")).toBe(false);
    expect(vatChecksumOk("12345")).toBe(false);
  });

  it("keys quarterly VAT periods like HMRC and dates them due a month and seven days after", () => {
    const p = quarterlyPeriods("2026-05-01", "2027-03-01");
    expect(p.map((x) => x.periodKey)).toEqual(["26A1", "26A2", "26A3", "27A1"]);
    expect(p[0]).toMatchObject({ start: "2026-05-01", end: "2026-07-31", due: "2026-09-07" });
    expect(p[2]).toMatchObject({ start: "2026-11-01", end: "2027-01-31", due: "2027-03-07" });
  });

  it("refuses 9-box figures HMRC would reject", () => {
    const ok = { box1: "100.00", box2: "0.00", box3: "100.00", box4: "40.00", box5: "60.00", box6: "500", box7: "200", box8: "0", box9: "0" };
    expect(() => validateBoxes(ok)).not.toThrow();
    expect(() => validateBoxes({ ...ok, box5: "61.00" })).toThrow(/box5/);
    expect(() => validateBoxes({ ...ok, box6: "500.50" })).toThrow(/whole pounds/);
  });

  it("reads a plain-text freight invoice", () => {
    const x = rulesExtract([
      "Felixstowe Freight Services Ltd",
      "Dock Gate 2, Walton Avenue, Felixstowe IP11 3HH",
      "VAT Reg No: GB 193 8475 18",
      "TAX INVOICE",
      "Invoice No: FFS-8906",
      "Invoice Date: 14/10/2026",
      "Due Date: 28/10/2026",
      "Container: MSCU7712045",
      "",
      "Ocean freight Ningbo to Felixstowe 40ft      1,640.00",
      "Terminal handling charges                    185.00",
      "Delivery to Reading                          310.00",
      "",
      "Subtotal  2,135.00",
      "VAT 20%  427.00",
      "Total due  2,562.00",
    ].join("\n"));
    expect(x).toMatchObject({
      docType: "freight_invoice", supplierName: "Felixstowe Freight Services Ltd", supplierVatNumber: "193847518",
      invoiceNumber: "FFS-8906", invoiceDate: "2026-10-14", dueDate: "2026-10-28", containerRef: "MSCU7712045",
      net: "2135.00", vat: "427.00", total: "2562.00", currency: "GBP",
    });
    expect(x.lines).toHaveLength(3);
    expect(x.notes).toEqual([]);
    expect(x.confidence).toBe(1);
  });

  it("shows bank lines only on working days and never in the future", () => {
    const lines = demoBankLines({ tenantId: "t", today: "2026-10-31", payments: [{ id: "p1", date: "2026-10-24", gbp: "100.00", direction: "receipt", reference: "INV-1", contact: "Acme Ltd", currency: "GBP", amount: "100.00" }], vatPayments: [], balance: "1000" }, "2026-10-01", "2026-11-30");
    expect(lines.every((l) => l.date <= "2026-10-31")).toBe(true);
    const pay = lines.find((l) => l.description.includes("ACME"))!;
    expect([1, 2, 3, 4, 5]).toContain(new Date(`${pay.date}T00:00:00Z`).getUTCDay());
    expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length);
  });
});

let db: Database;
let app: FastifyInstance;

function client() {
  let cookie = "";
  const call = async (method: InjectOptions["method"], url: string, body?: unknown) => {
    const res = await app.inject({ method, url, payload: body as InjectOptions["payload"], headers: cookie ? { cookie } : {} });
    const set = res.headers["set-cookie"];
    if (set) cookie = (Array.isArray(set) ? set[0]! : set).split(";")[0]!;
    return { status: res.statusCode, body: res.body ? (() => { try { return res.json(); } catch { return res.body; } })() : undefined };
  };
  const ok = async (method: InjectOptions["method"], url: string, body?: unknown) => {
    const r = await call(method, url, body);
    if (r.status >= 400) throw new Error(`${method} ${url} → ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  return { call, ok };
}

beforeAll(async () => {
  db = await createPgliteDatabase();
  await migrate(db);
  // Always the demo providers here, whatever the developer's environment says.
  app = await buildServer(db, { providers: createProviders({}) });
});

afterAll(async () => {
  await app.close();
  await db.close();
});

describe("platform services on demo providers", () => {
  const c = client();
  const ids: Record<string, string> = {};
  const t = today();

  it("sets up a VAT-registered importer", async () => {
    await c.ok("POST", "/api/auth/signup", { companyName: "Wessex Cookware Distribution Ltd", companyNumber: "12098345", vatNumber: "GB331920035",
      name: "Sam Patel", email: "sam@wessex.example", password: "correct horse battery" });
    ids.supplier = (await c.ok("POST", "/api/contacts", { kind: "supplier", name: "Ningbo Homeware Export Co", currency: "USD" })).id;
    ids.freight = (await c.ok("POST", "/api/contacts", { kind: "supplier", name: "Felixstowe Freight Services Ltd", vatNumber: "GB193847518", companyNumber: "05529761", paymentTermsDays: 14 })).id;
    ids.customer = (await c.ok("POST", "/api/contacts", { kind: "customer", name: "Bath Home Stores Ltd", email: "accounts@bathhome.example", paymentTermsDays: 30, creditLimit: "500" })).id;
    ids.pan = (await c.ok("POST", "/api/products", { sku: "PAN-24", name: "Frying pan 24cm", weightKg: "1.1", salesPrice: "19.00", reorderLevel: "40" })).id;
  });

  it("verifies a supplier against Companies House and HMRC", async () => {
    const v = await c.ok("POST", `/api/contacts/${ids.freight}/verify`);
    expect(v.ok).toBe(true);
    expect(v.company).toMatchObject({ name: "FELIXSTOWE FREIGHT SERVICES LTD", status: "active" });
    expect(v.vat).toMatchObject({ valid: true });
    expect(v.vat.consultationNumber).toMatch(/^[0-9A-F]{3}-[0-9A-F]{3}-[0-9A-F]{3}$/);
    const search = await c.ok("GET", "/api/lookup/companies?q=bath%20home");
    expect(search[0]).toMatchObject({ companyNumber: "07264418" });
  });

  it("buys, receives and sells, with the exchange rate filled in from reference rates", async () => {
    const date = addDays(t, -60);
    const fx = await c.ok("GET", `/api/fx/rate?currency=USD&date=${date}`);
    expect(Number(fx.rate)).toBeGreaterThan(0.6);
    expect(Number(fx.rate)).toBeLessThan(0.9);
    const po = await c.ok("POST", "/api/purchase-orders", { supplierId: ids.supplier, date, rate: fx.rate, lines: [{ productId: ids.pan, quantity: 100, unitPrice: "6.10", vatCode: "OS" }] });
    await c.ok("POST", `/api/purchase-orders/${po.id}/approve`);
    const detail = await c.ok("GET", `/api/purchase-orders/${po.id}`);
    await c.ok("POST", `/api/purchase-orders/${po.id}/receive`, { date: addDays(date, 30), lines: [{ poLineId: detail.lines[0].id, quantity: 100 }] });
    const inv = await c.ok("POST", "/api/sales-invoices", { customerId: ids.customer, date: addDays(t, -45), lines: [{ productId: ids.pan, quantity: 70, unitPrice: "11.50" }] });
    ids.invoice = inv.id;
    ids.poNumber = detail.number;
  });

  it("drafts a reorder for stock below its reorder level", async () => {
    const run = await c.ok("POST", "/api/automations/reorder/run");
    expect(run).toMatchObject({ status: "ok" });
    const pos = await c.ok("GET", "/api/purchase-orders") as { status: string; notes: string | null; id: string }[];
    const draft = pos.find((p) => p.status === "draft" && p.notes?.includes("reorder automation"))!;
    expect(draft).toBeTruthy();
    const lines = (await c.ok("GET", `/api/purchase-orders/${draft.id}`)).lines;
    expect(Number(lines[0].quantity)).toBe(50); // twice the reorder level, less the 30 on hand
    expect((await c.ok("POST", "/api/automations/reorder/run")).status).toBe("skipped"); // not twice
  });

  it("chases the overdue invoice once per stage, in the outbox", async () => {
    const r = await c.ok("POST", "/api/automations/overdue_reminders/run");
    expect(r.status).toBe("ok");
    expect(r.actions[0].label).toMatch(/^Second reminder/); // 15 days overdue: straight to stage two, not every stage
    const again = await c.ok("POST", "/api/automations/overdue_reminders/run");
    expect(again.status).toBe("skipped");
    const outbox = await c.ok("GET", `/api/outbox?relatedId=${ids.invoice}`);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ status: "sent", mode: "demo", to_address: "accounts@bathhome.example", created_by: "automation" });
    const anomalies = await c.ok("GET", "/api/analytics/anomalies") as { kind: string }[];
    expect(anomalies.some((a) => a.kind === "credit_limit")).toBe(true);
  });

  it("reads a freight invoice from the inbox and posts it after review", async () => {
    const text = `Felixstowe Freight Services Ltd\nVAT Reg No: GB193847518\nInvoice No: FFS-9001\nInvoice Date: ${t.split("-").reverse().join("/")}\nContainer: OOLU8812094\n\nOcean freight 20ft      980.00\nPort charges            120.00\n\nSubtotal  1,100.00\nVAT 20%  220.00\nTotal due  1,320.00`;
    const up = await c.ok("POST", "/api/documents", { filename: "FFS-9001.txt", mediaType: "text/plain", content: text });
    expect(up.result).toMatchObject({ status: "extracted", doc_type: "freight_invoice" });
    const doc = await c.ok("GET", `/api/documents/${up.id}`);
    const proposal = doc.extraction.proposal;
    expect(proposal.supplierId).toBe(ids.freight);
    expect(proposal.input.lines).toEqual([
      expect.objectContaining({ kind: "account", accountCode: "2110", net: "980.00", vatCode: "S20" }),
      expect.objectContaining({ kind: "account", accountCode: "2110", net: "120.00", vatCode: "S20" }),
    ]);
    const bill = await c.ok("POST", `/api/documents/${up.id}/convert`, proposal.input);
    const b = await c.ok("GET", `/api/supplier-bills/${bill.id}`);
    expect(b.total).toBe("1320.00");
    // Uploading the same file again does not create a second document.
    const dup = await c.call("POST", "/api/documents", { filename: "copy.txt", mediaType: "text/plain", content: text });
    expect(dup.body.duplicate).toBe(true);
    // And reading another copy of the invoice spots that it is already entered.
    const again = await c.ok("POST", "/api/documents", { filename: "FFS-9001 resent.txt", mediaType: "text/plain", content: `${text}\n` });
    expect(again.result.status).toBe("needs_review");
  });

  it("connects a bank feed, pulls lines and reconciles what it can on its own", async () => {
    // Customer pays part of the invoice; the bank shows it a day or two later.
    await c.ok("POST", "/api/payments", { direction: "receipt", contactId: ids.customer, date: addDays(t, -6), bankAccountCode: "1200", amount: "300.00", reference: "BHS REMIT", allocations: [{ documentId: ids.invoice, amount: "300.00" }] });
    await c.ok("POST", "/api/bank/rules", { name: "Bank charges", matchText: "MONTHLY ACCOUNT FEE", direction: "out", accountCode: "7900" });
    await c.ok("POST", "/api/bank/rules", { name: "Fuel", matchText: "SHELL", direction: "out", accountCode: "7500", vatCode: "S20" });
    expect((await c.ok("POST", "/api/integrations/bank/connect", { bankAccountCode: "1200" })).connected).toBe(true);
    const sync = await c.ok("POST", "/api/integrations/bank/sync", { bankAccountCode: "1200" });
    expect(sync.added).toBeGreaterThan(5);
    expect((await c.ok("POST", "/api/integrations/bank/sync", { bankAccountCode: "1200" })).added).toBe(0);
    const run = await c.ok("POST", "/api/automations/bank_matching/run");
    expect(run.actions.some((a: { type: string }) => a.type === "matched")).toBe(true);
    expect(run.actions.some((a: { type: string; label: string }) => a.type === "coded" && /Fuel/.test(a.label))).toBe(true);
    const integrity = await c.ok("GET", "/api/reports/integrity");
    expect(integrity.allReconciled).toBe(true);
  });

  it("finalises a VAT return and submits it to HMRC", async () => {
    const obligations0 = await c.call("GET", "/api/vat/obligations");
    expect(obligations0.status).toBe(409); // not connected yet
    expect((await c.ok("POST", "/api/integrations/hmrc/connect")).connected).toBe(true);
    const obligations = await c.ok("GET", "/api/vat/obligations") as { periodKey: string; start: string; end: string; status: string }[];
    const first = obligations[0]!;
    expect(first.status).toBe("O");
    const ret = await c.ok("POST", "/api/vat/returns", { periodKey: first.periodKey, from: first.start, to: first.end, lockBooks: false });
    const sub = await c.ok("POST", `/api/vat/returns/${ret.id}/submit`, { declaration: true, fraud: { timezone: "UTC+00:00", screens: "width=1920&height=1080&scaling-factor=1&colour-depth=24" } });
    expect(sub.receipt.formBundleNumber).toMatch(/^\d{12}$/);
    const after = await c.ok("GET", "/api/vat/obligations") as { periodKey: string; status: string; returnStatus: string }[];
    expect(after.find((o) => o.periodKey === first.periodKey)).toMatchObject({ status: "F", returnStatus: "submitted" });
    expect((await c.call("POST", `/api/vat/returns/${ret.id}/submit`, { declaration: true })).status).toBe(422);
  });

  it("answers questions from the books with the demo assistant", async () => {
    for (const path of ["margin?by=product", "margin?by=customer", "margin?by=month", "cash-forecast", "fx-exposure", "stock-health", "suppliers", "shipments", "kpis"]) {
      await c.ok("GET", `/api/analytics/${path}`);
    }
    const cash = await c.ok("GET", "/api/analytics/cash-forecast");
    expect(cash.weeks).toHaveLength(13);
    const a = await c.ok("POST", "/api/assistant/ask", { question: "Which products make the best margin?" });
    expect(a.answer).toMatch(/Frying pan 24cm/);
    expect(a.toolsUsed[0].name).toBe("margin_by_product");
    expect((await c.ok("GET", "/api/assistant/history"))).toHaveLength(1);
  });

  it("turns on two-factor sign-in and asks for a code next time", async () => {
    const setup = await c.ok("POST", "/api/auth/mfa/setup");
    expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const enabled = await c.ok("POST", "/api/auth/mfa/enable", { code: hotp(setup.secret, step()) });
    expect(enabled.recoveryCodes).toHaveLength(10);

    const fresh = client();
    const login = await fresh.ok("POST", "/api/auth/login", { email: "sam@wessex.example", password: "correct horse battery" });
    expect(login.mfaRequired).toBe(true);
    expect((await fresh.call("GET", "/api/dashboard")).status).toBe(401);
    expect((await fresh.call("POST", "/api/auth/mfa/verify", { code: "000000" })).status).toBe(401);
    await fresh.ok("POST", "/api/auth/mfa/verify", { code: enabled.recoveryCodes[0] });
    expect((await fresh.call("GET", "/api/dashboard")).status).toBe(200);
    expect((await fresh.ok("GET", "/api/auth/me")).mfa_enabled).toBe(true);
  });

  it("adds the company's accountant to the team", async () => {
    await c.ok("POST", "/api/team", { name: "Daniel Okafor", email: "daniel@abbeysquare.example", role: "accountant", temporaryPassword: "temporary pass 2026" });
    const team = await c.ok("GET", "/api/team");
    expect(team.members.map((m: { role: string }) => m.role)).toEqual(["owner", "accountant"]);
    const acct = client();
    await acct.ok("POST", "/api/auth/login", { email: "daniel@abbeysquare.example", password: "temporary pass 2026" });
    expect((await acct.call("POST", "/api/team", { name: "X", email: "x@x.example", role: "viewer", temporaryPassword: "temporary pass 2026" })).status).toBe(403);
    const outbox = await c.ok("GET", "/api/outbox") as { template: string }[];
    expect(outbox.some((m) => m.template === "invitation")).toBe(true);
  });
});
