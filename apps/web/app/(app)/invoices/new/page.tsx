"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useContacts, useProducts, VatSelect } from "@/components/pickers";
import { Card, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { money, qty, roundHalfUp, sumPence, today, VAT_RATE } from "@/lib/format";

interface Line { productId: string; description: string; quantity: string; unitPrice: string; vatCode: string; returnToStock: boolean }
const blank = (): Line => ({ productId: "", description: "", quantity: "1", unitPrice: "", vatCode: "S20", returnToStock: true });

export default function NewInvoicePage() {
  const router = useRouter();
  const params = useSearchParams();
  const kind = params.get("kind") === "credit" ? "credit" : "invoice";
  const customers = useContacts("customer");
  const products = useProducts();
  const [customerId, setCustomerId] = useState(params.get("customerId") ?? "");
  const customer = customers.find((c) => c.id === customerId);
  const currency = customer?.currency ?? "GBP";
  const { data: invoices } = useApi<{ id: string; number: string; kind: string; customer_id: string }[]>(kind === "credit" ? "/api/sales-invoices" : null);
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const update = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const net = (l: Line) => roundHalfUp(Number(l.quantity || 0) * Number(l.unitPrice || 0));
  const vat = (l: Line) => (l.vatCode === "RC20" ? 0 : roundHalfUp(net(l) * (VAT_RATE[l.vatCode] ?? 0)));
  const totalNet = sumPence(lines.map(net));
  const totalVat = sumPence(lines.map(vat));

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    try {
      const { id } = await api(kind === "credit" ? "/api/credit-notes" : "/api/sales-invoices", {
        body: {
          customerId, date: f.date, dueDate: f.dueDate || undefined, customerRef: f.customerRef || undefined,
          rate: currency === "GBP" ? undefined : f.rate, creditsId: f.creditsId || undefined,
          lines: lines.filter((l) => l.productId || l.description).map((l) => ({
            productId: l.productId || undefined, description: l.description || undefined, quantity: l.quantity,
            unitPrice: l.unitPrice, vatCode: l.vatCode, returnToStock: kind === "credit" ? l.returnToStock : undefined,
          })),
        },
      });
      router.push(`/invoices/${id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <PageHeader title={kind === "credit" ? "New credit note" : "New invoice"} subtitle={kind === "invoice" ? "Stock lines are issued from the warehouse at average landed cost when you post." : undefined}>
        <button type="button" className="btn ghost" onClick={() => router.back()}>Cancel</button>
        <button className="btn primary" disabled={busy || !customerId}>Post {kind === "credit" ? "credit note" : "invoice"}</button>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card title="Customer" pad>
        <div className="form-grid">
          <Field label="Customer">
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
              <option value="">Choose customer…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Date"><input type="date" name="date" defaultValue={today()} required /></Field>
          {kind === "invoice" && <Field label="Due date" hint={customer ? `Defaults to ${customer.payment_terms_days} days` : undefined}><input type="date" name="dueDate" /></Field>}
          <Field label="Customer reference" hint="Their PO number"><input name="customerRef" /></Field>
          {kind === "credit" && (
            <Field label="Credits invoice" hint="Returned goods go back at their original cost">
              <select name="creditsId" defaultValue="">
                <option value="">None</option>
                {invoices?.filter((i) => i.kind === "invoice" && i.customer_id === customerId).map((i) => <option key={i.id} value={i.id}>{i.number}</option>)}
              </select>
            </Field>
          )}
          {currency !== "GBP" && <Field label={`Rate (GBP per 1 ${currency})`}><input name="rate" className="num" inputMode="decimal" required /></Field>}
        </div>
      </Card>
      <Card title={`Lines (${currency})`}>
        <div className="table-wrap card-pad">
          <table className="lines">
            <thead><tr><th style={{ width: "26%" }}>Product</th><th>Description</th><th>Qty</th><th>Unit price</th><th>VAT</th><th className="num">Net</th>{kind === "credit" && <th>Restock</th>}<th /></tr></thead>
            <tbody>
              {lines.map((l, i) => {
                const p = products.find((x) => x.id === l.productId);
                const short = kind === "invoice" && p?.track_stock && Number(l.quantity) > Number(p.on_hand);
                return (
                  <tr key={i}>
                    <td>
                      <select value={l.productId} aria-label="Product" onChange={(e) => {
                        const np = products.find((x) => x.id === e.target.value);
                        update(i, { productId: e.target.value, description: np?.name ?? l.description, unitPrice: np ? Number(np.sales_price).toFixed(2) : l.unitPrice, vatCode: np?.sales_vat_code ?? l.vatCode });
                      }}>
                        <option value="">No product (service)</option>
                        {products.map((x) => <option key={x.id} value={x.id}>{x.sku} · {x.track_stock ? `${qty(x.on_hand)} in stock` : "service"}</option>)}
                      </select>
                      {short && <small style={{ color: "var(--accent-text)" }}>Only {qty(p!.on_hand)} in stock</small>}
                    </td>
                    <td><input value={l.description} aria-label="Description" onChange={(e) => update(i, { description: e.target.value })} /></td>
                    <td style={{ width: 90 }}><input className="num" inputMode="decimal" aria-label="Quantity" value={l.quantity} onChange={(e) => update(i, { quantity: e.target.value })} /></td>
                    <td style={{ width: 120 }}><input className="num" inputMode="decimal" aria-label="Unit price" value={l.unitPrice} onChange={(e) => update(i, { unitPrice: e.target.value })} /></td>
                    <td style={{ width: 170 }}><VatSelect value={l.vatCode} onChange={(v) => update(i, { vatCode: v })} /></td>
                    <td className="num">{money(net(l), currency)}</td>
                    {kind === "credit" && <td><input type="checkbox" aria-label="Return to stock" checked={l.returnToStock} onChange={(e) => update(i, { returnToStock: e.target.checked })} disabled={!p?.track_stock} /></td>}
                    <td><button type="button" className="btn ghost small" aria-label="Remove line" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>×</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button type="button" className="btn small" style={{ marginTop: 12 }} onClick={() => setLines((ls) => [...ls, blank()])}>Add line</button>
        </div>
        <div className="totals">
          <span className="muted">Net</span><span>{money(totalNet, currency)}</span>
          <span className="muted">VAT</span><span>{money(totalVat, currency)}</span>
          <span className="grand">Total</span><span className="grand">{money(totalNet + totalVat, currency)}</span>
        </div>
      </Card>
    </form>
  );
}
