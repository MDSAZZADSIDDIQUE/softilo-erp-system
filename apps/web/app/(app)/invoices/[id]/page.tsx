"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Card, ErrorBanner, Field, Loading, PageHeader, paymentStatus, Status } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date, money, qty } from "@/lib/format";

interface Address { line1?: string; city?: string; postcode?: string }
interface Invoice {
  id: string; number: string; kind: string; customer_id: string; customer_name: string; customer_address: Address; customer_vat_number: string | null;
  customer_ref: string | null; date: string; due_date: string; currency: string; total: string; amount_paid: string; outstanding: string; overdue?: boolean;
  entry_id: string; journal_number: string; company_name: string; company_vat_number: string | null; company_number: string | null; company_address: Address;
  lines: { line_no: number; sku: string | null; description: string; quantity: string; unit_price: string; net: string; vat_code: string; vat: string }[];
  payments: { number: string; date: string; amount: string }[];
}

const VAT_LABEL: Record<string, string> = { S20: "20%", R5: "5%", Z0: "0%", EX: "Exempt", OS: "N/A", RC20: "RC" };

function addressLines(a: Address) {
  return [a.line1, a.city, a.postcode].filter(Boolean).map((l) => <div key={l}>{l}</div>);
}

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const { data: inv, error, reload } = useApi<Invoice>(`/api/sales-invoices/${id}`);
  const { data: open } = useApi<{ id: string; number: string; kind: string; customer_id: string; outstanding: string }[]>("/api/sales-invoices");
  const [applyError, setApplyError] = useState<string>();

  if (!inv) return error ? <ErrorBanner message={error} /> : <div className="card"><Loading /></div>;
  const isCredit = inv.kind === "credit";
  const net = inv.lines.reduce((s, l) => s + Number(l.net), 0);
  const vat = inv.lines.reduce((s, l) => s + Number(l.vat), 0);
  const reverseCharge = inv.lines.some((l) => l.vat_code === "RC20");
  const applyTargets = open?.filter((x) => x.kind === "invoice" && x.customer_id === inv.customer_id && Number(x.outstanding) > 0) ?? [];

  return (
    <div className="stack">
      <PageHeader title={`${isCredit ? "Credit note" : "Invoice"} ${inv.number}`} subtitle={<>{inv.customer_name} · <Status value={paymentStatus({ ...inv, overdue: !isCredit && Number(inv.outstanding) > 0 && inv.due_date < new Date().toISOString().slice(0, 10) })} /></>}>
        <Link className="btn ghost no-print" href={`/journals/${inv.entry_id}`}>Journal {inv.journal_number}</Link>
        {!isCredit && <Link className="btn no-print" href={`/invoices/new?kind=credit&customerId=${inv.customer_id}`}>Credit</Link>}
        <button className="btn no-print" onClick={() => window.print()}>Print / PDF</button>
        {!isCredit && Number(inv.outstanding) > 0 && <Link className="btn primary no-print" href={`/payments/new?direction=receipt&contactId=${inv.customer_id}&documentId=${inv.id}`}>Record payment</Link>}
      </PageHeader>

      {isCredit && Number(inv.outstanding) > 0 && applyTargets.length > 0 && (
        <Card title="Apply this credit" pad>
          <ErrorBanner message={applyError} />
          <form style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" }} onSubmit={async (e) => {
            e.preventDefault();
            const f = Object.fromEntries(new FormData(e.currentTarget));
            try { await api(`/api/credit-notes/${inv.id}/apply`, { body: f }); setApplyError(undefined); await reload(); } catch (err) { setApplyError((err as Error).message); }
          }}>
            <Field label="Against invoice"><select name="invoiceId">{applyTargets.map((t) => <option key={t.id} value={t.id}>{t.number} ({money(t.outstanding)} due)</option>)}</select></Field>
            <Field label="Amount"><input name="amount" className="num" defaultValue={inv.outstanding} /></Field>
            <button className="btn primary">Apply</button>
          </form>
        </Card>
      )}

      <article className="document">
        <header>
          <div>
            <img src="/brand/logo.svg" alt="Softilo" />
            <div style={{ marginTop: 16, fontSize: 13, color: "#4f4d47" }}>
              <strong style={{ color: "#191712", fontWeight: 500 }}>{inv.company_name}</strong>
              {addressLines(inv.company_address ?? {})}
              {inv.company_vat_number && <div>VAT reg. GB{inv.company_vat_number}</div>}
              {inv.company_number && <div>Company no. {inv.company_number}</div>}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="doc-title">{isCredit ? "Credit note" : "Tax invoice"}</div>
            <div className="accent-rule" />
            <dl className="meta" style={{ marginTop: 16, fontSize: 13, justifyContent: "end" }}>
              <dt>Number</dt><dd>{inv.number}</dd>
              <dt>Date</dt><dd>{date(inv.date)}</dd>
              {!isCredit && <><dt>Due</dt><dd>{date(inv.due_date)}</dd></>}
              {inv.customer_ref && <><dt>Your ref</dt><dd>{inv.customer_ref}</dd></>}
            </dl>
          </div>
        </header>
        <div style={{ marginBottom: 28, fontSize: 13 }}>
          <div style={{ color: "#4f4d47", fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em" }}>Bill to</div>
          <strong style={{ fontWeight: 500, fontSize: 15 }}>{inv.customer_name}</strong>
          {addressLines(inv.customer_address ?? {})}
          {inv.customer_vat_number && <div>VAT reg. GB{inv.customer_vat_number}</div>}
        </div>
        <table className="data">
          <thead><tr><th>Description</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">VAT</th><th className="num">Net</th></tr></thead>
          <tbody>
            {inv.lines.map((l) => (
              <tr key={l.line_no}>
                <td>{l.description}{l.sku && <span style={{ color: "#8a867d" }}> · {l.sku}</span>}</td>
                <td className="num">{qty(l.quantity)}</td>
                <td className="num">{money(l.unit_price, inv.currency)}</td>
                <td className="num">{VAT_LABEL[l.vat_code] ?? l.vat_code}</td>
                <td className="num">{money(l.net, inv.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="totals" style={{ paddingRight: 14 }}>
          <span>Net</span><span>{money(net, inv.currency)}</span>
          <span>VAT</span><span>{money(vat, inv.currency)}</span>
          <span className="grand">Total {inv.currency}</span><span className="grand">{money(inv.total, inv.currency)}</span>
          {Number(inv.amount_paid) > 0 && <><span>Paid</span><span>{money(`-${inv.amount_paid}`, inv.currency)}</span><span className="grand">Balance due</span><span className="grand">{money(inv.outstanding, inv.currency)}</span></>}
        </div>
        {reverseCharge && <p style={{ fontSize: 12, color: "#4f4d47" }}>Reverse charge: customer to account for VAT to HMRC.</p>}
        {inv.payments.length > 0 && (
          <p style={{ fontSize: 12, color: "#4f4d47" }}>Payments received: {inv.payments.map((p) => `${money(p.amount, inv.currency)} on ${date(p.date)}`).join(", ")}.</p>
        )}
      </article>
    </div>
  );
}
