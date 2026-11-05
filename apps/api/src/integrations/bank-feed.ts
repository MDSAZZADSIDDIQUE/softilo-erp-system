import { createHash } from "node:crypto";
import { httpJson, missing } from "./config.js";
import type { BankAuth, BankFeedProvider, FeedAccount, FeedTransaction } from "./types.js";

export interface DemoBankSeed {
  tenantId: string;
  today: string;
  payments: { id: string; date: string; gbp: string; direction: string; reference: string | null; contact: string; currency: string; amount: string }[];
  vatPayments: { periodKey: string; due: string; amount: string }[];
  balance: string;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (d: Date) => d.toISOString().slice(0, 10);
function shift(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}
/** Banks only post on working days: Saturday and Sunday roll to Monday. */
function workingDay(date: string) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 6 ? shift(date, 2) : day === 0 ? shift(date, 1) : date;
}
const upper = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 &]/g, "").slice(0, 32).trim();

/**
 * What the company's bank would show: every payment and receipt it has recorded, cleared a working day or
 * two later in UK bank wording, plus the card spend, direct debits, fees and interest that never go
 * through a sub-ledger and need coding. Deterministic for a given company, so a demo stays stable.
 */
export function demoBankLines(seed: DemoBankSeed, from: string, to: string): FeedTransaction[] {
  const lines: FeedTransaction[] = [];
  const end = to < seed.today ? to : seed.today;
  const add = (key: string, date: string, description: string, reference: string | null, amount: number) => {
    if (date >= from && date <= end && amount !== 0) {
      lines.push({ id: `demo-${hash(`${seed.tenantId}|${key}`).slice(0, 24)}`, date, description, reference, amount: amount.toFixed(2) });
    }
  };
  for (const p of seed.payments) {
    const lag = parseInt(hash(p.id).slice(0, 2), 16) % 3; // clears same day to two working days later
    const date = workingDay(shift(p.date, lag));
    const gbp = Number(p.gbp);
    if (p.direction === "receipt") {
      add(`pay|${p.id}`, date, `FASTER PAYMENT ${upper(p.contact)}`, p.reference?.slice(0, 18) ?? null, gbp);
    } else if (p.currency !== "GBP") {
      add(`pay|${p.id}`, date, `INTL PAYMENT ${p.currency} ${Number(p.amount).toLocaleString("en-GB", { minimumFractionDigits: 2 })} ${upper(p.contact)}`, p.reference?.slice(0, 18) ?? null, -gbp);
    } else {
      add(`pay|${p.id}`, date, `BACS ${upper(p.contact)}`, p.reference?.slice(0, 18) ?? null, -gbp);
    }
  }
  for (const v of seed.vatPayments) add(`vat|${v.periodKey}`, workingDay(shift(v.due, -3)), "HMRC VAT", `${v.periodKey} VRN`, -Number(v.amount));

  // Day-to-day spending that only the bank knows about.
  const start = new Date(`${from}T00:00:00Z`);
  for (let d = new Date(start); iso(d) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = iso(d);
    const dow = d.getUTCDay();
    const dom = d.getUTCDate();
    const r = parseInt(hash(`${seed.tenantId}|${day}`).slice(0, 6), 16) / 0xffffff;
    if (dow === 2) add(`fuel|${day}`, day, "CARD 4417 SHELL READING", null, -(58 + Math.round(r * 3400) / 100));
    if (dow === 4 && r > 0.35) add(`post|${day}`, day, "CARD 4417 ROYAL MAIL GROUP", null, -(24 + Math.round(r * 9000) / 100));
    if (dom === 3) add(`bt|${day}`, workingDay(day), "BT BUSINESS DD", "BB0042881573", -64.80);
    if (dom === 12) add(`ins|${day}`, workingDay(day), "HISCOX UK DD", "POL 4418820", -212.40);
    if (dom === 21) add(`fee|${day}`, workingDay(day), "MONTHLY ACCOUNT FEE", null, -18.00);
    if (dom === 28) add(`int|${day}`, workingDay(day), "CREDIT INTEREST", null, Math.round(Math.max(0, Number(seed.balance)) * 0.0004 * 100) / 100);
    if (dom === 15 && r > 0.5) add(`amzn|${day}`, day, "CARD 4417 AMAZON MKTPLACE", null, -(18 + Math.round(r * 6000) / 100));
  }
  return lines.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export function demoBankFeed(): BankFeedProvider {
  const seedFor = (auth: BankAuth) => auth.seed as DemoBankSeed;
  return {
    info: () => ({ mode: "demo", name: "Built-in demo bank (Open Banking simulator)", ready: true }),
    authoriseUrl: () => null,
    exchangeCode: async () => ({ accessToken: "demo", refreshToken: "demo", expiresIn: 90 * 86400 }),
    async accounts(auth) {
      const s = seedFor(auth);
      return [{ id: "demo-current", name: "Business Current Account", sortCode: "30-96-26", accountNumber: "41873309", currency: "GBP", balance: s.balance }];
    },
    async transactions(auth, _accountId, from, to) {
      return demoBankLines(seedFor(auth), from, to);
    },
  };
}

/** TrueLayer Data API (FCA-authorised account information provider). Sandbox unless TRUELAYER_ENV=production. */
export function liveBankFeed(env: NodeJS.ProcessEnv = process.env): BankFeedProvider {
  const prod = env.TRUELAYER_ENV === "production";
  const api = prod ? "https://api.truelayer.com" : "https://api.truelayer-sandbox.com";
  const auth = prod ? "https://auth.truelayer.com" : "https://auth.truelayer-sandbox.com";
  const need = missing(env, ["TRUELAYER_CLIENT_ID", "TRUELAYER_CLIENT_SECRET"]);
  const bearer = (a: BankAuth) => ({ authorization: `Bearer ${a.accessToken}` });
  return {
    info: () => ({ mode: "live", name: prod ? "TrueLayer (production)" : "TrueLayer (sandbox)", ready: !need.length, missing: need }),
    authoriseUrl: (state, redirectUri) => `${auth}/?${new URLSearchParams({
      response_type: "code", client_id: env.TRUELAYER_CLIENT_ID ?? "", scope: "info accounts balance transactions offline_access",
      redirect_uri: redirectUri, providers: prod ? "uk-ob-all" : "uk-cs-mock", state,
    })}`,
    async exchangeCode(code, redirectUri) {
      const r = await httpJson<{ access_token: string; refresh_token: string; expires_in: number }>(`${auth}/connect/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: env.TRUELAYER_CLIENT_ID ?? "", client_secret: env.TRUELAYER_CLIENT_SECRET ?? "", redirect_uri: redirectUri, code }),
      });
      return { accessToken: r.access_token, refreshToken: r.refresh_token, expiresIn: r.expires_in };
    },
    async accounts(a) {
      type Acc = { account_id: string; display_name: string; currency: string; account_number?: { number?: string; sort_code?: string } };
      const r = await httpJson<{ results: Acc[] }>(`${api}/data/v1/accounts`, { headers: bearer(a) });
      const out: FeedAccount[] = [];
      for (const acc of r.results) {
        const b = await httpJson<{ results: { current: number }[] }>(`${api}/data/v1/accounts/${acc.account_id}/balance`, { headers: bearer(a) });
        out.push({ id: acc.account_id, name: acc.display_name, currency: acc.currency, sortCode: acc.account_number?.sort_code,
          accountNumber: acc.account_number?.number, balance: (b.results[0]?.current ?? 0).toFixed(2) });
      }
      return out;
    },
    async transactions(a, accountId, from, to) {
      type T = { transaction_id: string; timestamp: string; description: string; amount: number; meta?: { provider_reference?: string } };
      const r = await httpJson<{ results: T[] }>(`${api}/data/v1/accounts/${accountId}/transactions?${new URLSearchParams({ from, to })}`, { headers: bearer(a) });
      return r.results.map((t) => ({ id: t.transaction_id, date: t.timestamp.slice(0, 10), description: t.description,
        reference: t.meta?.provider_reference ?? null, amount: t.amount.toFixed(2) }));
    },
  };
}
