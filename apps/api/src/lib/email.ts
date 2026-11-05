import { newId, type Sql } from "@softilo/db";
import type { Providers } from "../integrations/index.js";
import type { Ctx } from "./context.js";
import { audit } from "./ledger.js";

export interface Message {
  template: string;
  to: string;
  toName?: string;
  subject: string;
  body: string;
  relatedType?: string;
  relatedId?: string;
  /** Automations say so even when a person pressed "run now". */
  by?: "user" | "automation";
}

/**
 * Send an email from the company and keep a copy in the outbox. In demo mode nothing leaves the server:
 * the message is stored as sent so it can be read in Automations → Outbox.
 */
export async function sendEmail(tx: Sql, ctx: Ctx, providers: Providers, m: Message) {
  const [t] = await tx.query<{ name: string; settings_email: string | null }>("SELECT name, address->>'email' AS settings_email FROM tenants");
  const id = newId();
  const mode = providers.email.info().mode;
  let status = "sent";
  let providerRef: string | null = null;
  let error: string | null = null;
  try {
    const r = await providers.email.send({
      to: m.to, toName: m.toName, from: process.env.EMAIL_FROM ?? "accounts@softilo.test", fromName: t!.name,
      replyTo: t!.settings_email ?? undefined, subject: m.subject, text: m.body,
    });
    providerRef = r.id;
  } catch (e) {
    status = "failed";
    error = (e as Error).message;
  }
  await tx.query(
    `INSERT INTO outbox_messages (id, tenant_id, template, to_address, to_name, subject, body, related_type, related_id, status, mode, provider_ref, error, created_by, sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, CASE WHEN $10 = 'sent' THEN now() END)`,
    [id, ctx.tenantId, m.template, m.to, m.toName ?? null, m.subject, m.body, m.relatedType ?? null, m.relatedId ?? null,
      status, mode, providerRef, error, m.by ?? (ctx.userId ? "user" : "automation")]);
  await audit(tx, ctx, `email.${status}`, m.relatedType ?? "outbox_message", m.relatedId ?? id, { template: m.template, to: m.to, subject: m.subject });
  return { id, status, error };
}

const gbp = (v: string | number, cur = "GBP") =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: cur }).format(Number(v));
const ukDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export interface InvoiceForEmail {
  number: string; date: string; due_date: string; total: string; outstanding: string; currency: string;
  customer_name: string; company_name: string; customer_ref: string | null; days_overdue?: number;
}

/** Wording follows the usual UK credit-control ladder: a friendly nudge, a firm reminder, then a final notice. */
export function reminderText(stage: 1 | 2 | 3, inv: InvoiceForEmail, bank: { name: string; sortCode?: string; account?: string }) {
  const amount = gbp(inv.outstanding, inv.currency);
  const ref = inv.customer_ref ? ` (your ref ${inv.customer_ref})` : "";
  const pay = bank.sortCode ? `\n\nPayment details: ${bank.name}, sort code ${bank.sortCode}, account ${bank.account}. Please quote ${inv.number}.` : "";
  const sign = `\n\nKind regards,\nCredit control\n${inv.company_name}`;
  if (stage === 1) {
    return {
      subject: `Payment reminder: invoice ${inv.number}`,
      body: `Hello,\n\nA quick reminder that invoice ${inv.number}${ref}, dated ${ukDate(inv.date)}, was due on ${ukDate(inv.due_date)} and ${amount} is still outstanding.\n\nIf you have already paid, thank you, and please ignore this email.${pay}${sign}`,
    };
  }
  if (stage === 2) {
    return {
      subject: `Overdue: invoice ${inv.number} (${inv.days_overdue} days)`,
      body: `Hello,\n\nInvoice ${inv.number}${ref} for ${amount} is now ${inv.days_overdue} days overdue. We have not received payment or heard of any query with the goods.\n\nPlease arrange payment this week, or reply to let us know when it will be paid.${pay}${sign}`,
    };
  }
  return {
    subject: `Final notice: invoice ${inv.number}`,
    body: `Hello,\n\nDespite our earlier reminders, ${amount} on invoice ${inv.number}${ref} remains unpaid, ${inv.days_overdue} days after it was due.\n\nUnless payment is received within 7 days we will place your account on stop and may add late payment interest and compensation under the Late Payment of Commercial Debts (Interest) Act 1998.${pay}${sign}`,
  };
}

export function invoiceText(inv: InvoiceForEmail) {
  return {
    subject: `Invoice ${inv.number} from ${inv.company_name}`,
    body: `Hello,\n\nPlease find invoice ${inv.number}${inv.customer_ref ? ` for your order ${inv.customer_ref}` : ""}, dated ${ukDate(inv.date)}, for ${gbp(inv.total, inv.currency)}. Payment is due by ${ukDate(inv.due_date)}.\n\nThank you for your business.\n\nKind regards,\n${inv.company_name}`,
  };
}
