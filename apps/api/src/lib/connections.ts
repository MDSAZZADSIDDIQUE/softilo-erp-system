import { createHash } from "node:crypto";
import { newId, type Sql } from "@softilo/db";
import { d } from "@softilo/domain";
import type { DemoBankSeed } from "../integrations/bank-feed.js";
import { quarterlyPeriods } from "../integrations/hmrc.js";
import type { BankAuth, HmrcAuth, Providers } from "../integrations/index.js";
import type { Ctx } from "./context.js";
import { seal, unseal } from "./crypto.js";
import { AppError } from "./errors.js";
import { audit } from "./ledger.js";
import { today } from "./schemas.js";

export type Connection = {
  id: string; provider: string; mode: "demo" | "live"; status: string; label: string | null; external_ref: string | null;
  account_code: string | null; secrets: string | null; expires_at: string | null; last_synced_at: string | null;
};

interface Tokens { accessToken: string; refreshToken: string }

export async function findConnection(tx: Sql, provider: string, accountCode?: string): Promise<Connection | undefined> {
  const [c] = await tx.query<Connection>(
    `SELECT * FROM integration_connections WHERE provider = $1 AND status = 'connected' AND ($2::text IS NULL OR account_code = $2)
      ORDER BY created_at DESC LIMIT 1`, [provider, accountCode ?? null]);
  return c;
}

export async function saveTokens(tx: Sql, id: string, t: { accessToken: string; refreshToken: string; expiresIn: number }) {
  await tx.query(
    "UPDATE integration_connections SET secrets = $2, expires_at = now() + make_interval(secs => $3), status = 'connected', state = NULL, last_error = NULL WHERE id = $1",
    [id, seal({ accessToken: t.accessToken, refreshToken: t.refreshToken }), t.expiresIn]);
}

/** First day of the tenant's VAT periods: its first return, else the month of its first VAT transaction. */
async function firstVatPeriodStart(tx: Sql): Promise<string> {
  const [r] = await tx.query<{ start: string | null }>(
    `SELECT coalesce((SELECT min(start_date) FROM vat_returns),
                     (SELECT date_trunc('month', min(date))::date FROM vat_entries),
                     date_trunc('month', current_date)::date)::text AS start`);
  return r!.start!;
}

/** Everything a call to HMRC needs: the VRN, a fresh access token (refreshed if it has expired) and filing history. */
export async function hmrcAuth(tx: Sql, providers: Providers): Promise<HmrcAuth> {
  const [t] = await tx.query<{ vat_number: string | null }>("SELECT vat_number FROM tenants");
  if (!t?.vat_number) throw new AppError(422, "Add the company's VAT number in Settings first", "unprocessable");
  const conn = await findConnection(tx, "hmrc_vat");
  if (!conn) throw new AppError(409, "Connect Softilo to HMRC first (VAT → Connect to HMRC)", "not_connected");
  const filed = await tx.query<{ periodKey: string; submittedAt: string }>(
    `SELECT period_key AS "periodKey", submitted_at::text AS "submittedAt" FROM vat_returns WHERE status = 'submitted' AND submission_mode = $1`, [conn.mode]);
  let accessToken: string | undefined;
  if (conn.mode === "live") {
    const tokens = unseal<Tokens>(conn.secrets ?? "");
    accessToken = tokens.accessToken;
    if (!conn.expires_at || new Date(conn.expires_at).getTime() < Date.now() + 60_000) {
      const next = await providers.hmrc.refresh(tokens.refreshToken);
      await saveTokens(tx, conn.id, next);
      accessToken = next.accessToken;
    }
  }
  return { vrn: t.vat_number, accessToken, filed, firstPeriodStart: await firstVatPeriodStart(tx) };
}

/** The demo bank shows what really happened in the ledger: payments through that account and VAT paid to HMRC. */
export async function demoBankSeed(tx: Sql, ctx: Ctx, accountCode: string): Promise<DemoBankSeed> {
  const payments = await tx.query<DemoBankSeed["payments"][number]>(
    `SELECT p.id, p.date::text, round(p.amount * p.rate, 2)::text AS gbp, p.direction, p.reference, c.name AS contact, p.currency, p.amount::text
       FROM payments p JOIN contacts c ON c.id = p.contact_id WHERE p.bank_account_code = $1 ORDER BY p.date`, [accountCode]);
  const returns = await tx.query<{ period_key: string; start_date: string; end_date: string; boxes: { box3: string; box4: string; box5: string } }>(
    "SELECT period_key, start_date::text, end_date::text, boxes FROM vat_returns ORDER BY end_date");
  const first = returns[0]?.start_date;
  const due = new Map(first ? quarterlyPeriods(first, today()).map((p) => [p.periodKey, p.due]) : []);
  const vatPayments = returns
    .filter((r) => d(r.boxes.box3).greaterThan(r.boxes.box4))
    .map((r) => ({ periodKey: r.period_key, due: due.get(r.period_key) ?? r.end_date, amount: r.boxes.box5 }));
  const [bal] = await tx.query<{ v: string }>("SELECT coalesce(sum(debit - credit), 0)::text AS v FROM journal_lines WHERE account_code = $1", [accountCode]);
  return { tenantId: ctx.tenantId, today: today(), payments, vatPayments, balance: bal!.v };
}

export async function bankAuth(tx: Sql, ctx: Ctx, conn: Connection): Promise<BankAuth> {
  if (conn.mode === "demo") return { seed: await demoBankSeed(tx, ctx, conn.account_code ?? "1200") };
  return { accessToken: unseal<Tokens>(conn.secrets ?? "").accessToken };
}

/**
 * Pull new lines from a bank feed into the reconciliation queue. Starts the day after the last line already
 * on that account (so a statement imported by CSV is never duplicated), and skips lines seen before by their
 * provider id. Returns how many were added.
 */
export async function syncBankFeed(tx: Sql, ctx: Ctx, providers: Providers, conn: Connection) {
  const code = conn.account_code ?? "1200";
  const [last] = await tx.query<{ last: string | null }>(
    "SELECT (max(date) FILTER (WHERE source = 'csv'))::text AS last FROM bank_transactions WHERE bank_account_code = $1", [code]);
  const [synced] = await tx.query<{ from: string }>(
    "SELECT (coalesce($1::date + 1, current_date - 90))::text AS from", [last?.last ?? null]);
  const from = synced!.from;
  const to = today();
  const auth = await bankAuth(tx, ctx, conn);
  const lines = await providers.bankFeed.transactions(auth, conn.external_ref ?? "", from, to);
  let added = 0;
  for (const l of lines) {
    const hash = createHash("sha256").update(`feed|${l.id}`).digest("hex");
    const rows = await tx.query(
      `INSERT INTO bank_transactions (id, tenant_id, bank_account_code, date, description, reference, amount, import_hash, source, external_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'feed',$9) ON CONFLICT DO NOTHING RETURNING id`,
      [newId(), ctx.tenantId, code, l.date, l.description, l.reference, l.amount, hash, l.id]);
    added += rows.length;
  }
  await tx.query("UPDATE integration_connections SET last_synced_at = now(), last_error = NULL WHERE id = $1", [conn.id]);
  await audit(tx, ctx, "bank_feed.synced", "integration_connection", conn.id, { from, to, received: lines.length, added });
  return { from, to, received: lines.length, added };
}

/** Reference rate for a day: from the shared table if we have it, else from the provider (then stored). */
export async function fxRate(tx: Sql, providers: Providers, currency: string, date: string): Promise<{ rate: string; date: string; source: string } | null> {
  if (currency === "GBP") return { rate: "1", date, source: "par" };
  const [have] = await tx.query<{ rate: string; date: string; source: string }>(
    "SELECT rate::text, date::text, source FROM fx_rates WHERE currency = $1 AND date <= $2 AND date > $2::date - 5 ORDER BY date DESC LIMIT 1",
    [currency, date]);
  if (have) return have;
  const got = await providers.fx.rates(date, [currency]);
  const r = got[0];
  if (!r) return null;
  const source = providers.fx.info().name;
  await tx.query(
    "INSERT INTO fx_rates (currency, date, rate, source) VALUES ($1,$2,$3,$4) ON CONFLICT (currency, date) DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source, fetched_at = now()",
    [r.currency, r.date, r.rate, source]);
  return { rate: r.rate, date: r.date, source };
}
