"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useContacts, useProducts, VatSelect } from "@core/components/pickers";
import { Card, ErrorBanner, Field, PageHeader } from "@core/components/ui";
import { api, useApi } from "@core/lib/api";
import { date as fmtDate, money, qty, roundHalfUp, sumPence, today, VAT_RATE } from "@core/lib/format";

interface Line { productId: string; description: string; quantity: string; unitPrice: string; vatCode: string; returnToStock: boolean; batchId: string }
const blank = (): Line => ({ productId: "", description: "", quantity: "1", unitPrice: "", vatCode: "Z0", returnToStock: true, batchId: "" });

interface Allocation { code: string; expiry: string | null; quantity: string; pastBestBefore: boolean }
interface BatchOption { id: string; code: string; expiry: string | null }

/** What FEFO will pick for one line, refreshed as the line changes. Lines earlier on the invoice are not netted off here. */
function AllocationPreview({ productId, quantity, date, customerId }: { productId: string; quantity: string; date: string; customerId: string }) {
  const [state, setState] = useState<{ allocation?: Allocation[]; error?: string; minLifeDays?: number }>({});
  useEffect(() => {
    if (!(Number(quantity) > 0)) return setState({});
    let live = true;
    const t = setTimeout(() => {
      api<{ allocation: Allocation[]; minLifeDays: number }>("/api/fnb/allocation-preview", { body: { productId, quantity, date, customerId: customerId || undefined } })
        .then((r) => live && setState(r))
        .catch((e: Error) => live && setState({ error: e.message.replace(/^Cannot allocate: /, "") }));
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [productId, quantity, date, customerId]);
  if (state.error) return <small className="alloc error">{state.error}</small>;
  if (!state.allocation) return null;
  return (
    <small className="alloc">
      FEFO: {state.allocation.map((a) => `${qty(a.quantity)} from ${a.code}${a.expiry ? ` (${fmtDate(a.expiry)})` : ""}${a.pastBestBefore ? ", past best-before" : ""}`).join("; ")}
      {state.minLifeDays ? ` · customer needs ${state.minLifeDays} days' life` : ""}
    </small>
  );
}

function ReturnBatch({ productId, value, onChange }: { productId: string; value: string; onChange: (v: string) => void }) {
  const { data } = useApi<BatchOption[]>(`/api/fnb/batches?productId=${productId}`);
  return (
    <select value={value} aria-label="Batch returned" onChange={(e) => onChange(e.target.value)} required>
      <option value="">Batch returned…</option>
      {data?.map((b) => <option key={b.id} value={b.id}>{b.code}{b.expiry ? ` · ${fmtDate(b.expiry)}` : ""}</option>)}
    </select>
  );
}

/** Batch-aware version of the core invoice screen: stock leaves first expiry, first out, and returns go back into a named batch. */
export default function NewInvoicePage() {
  const router = useRouter();
  const params = useSearchParams();
  const kind = params.get("kind") === "credit" ? "credit" : "invoice";
  const customers = useContacts("customer");
  const products = useProducts();
  const { data: food } = useApi<{ id: string; batch_tracked: boolean }[]>("/api/fnb/products");
  const tracked = new Set(food?.filter((p) => p.batch_tracked).map((p) => p.id));
  const [customerId, setCustomerId] = useState(params.get("customerId") ?? "");
  const [date, setDate] = useState(today());
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
      const { id } = await api(kind === "credit" ? "/api/fnb/credit-notes" : "/api/fnb/sales-invoices", {
        body: {
          customerId, date, dueDate: f.dueDate || undefined, customerRef: f.customerRef || undefined,
          rate: currency === "GBP" ? undefined : f.rate, creditsId: f.creditsId || undefined,
          lines: lines.filter((l) => l.productId || l.description).map((l) => {
            const restock = kind === "credit" && l.returnToStock;
            return {
              productId: l.productId || undefined, description: l.description || undefined, quantity: l.quantity,
              unitPrice: l.unitPrice, vatCode: l.vatCode, returnToStock: kind === "credit" ? l.returnToStock : undefined,
              batches: restock && tracked.has(l.productId) && l.batchId ? [{ batchId: l.batchId, quantity: l.quantity }] : undefined,
            };
          }),
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
      <PageHeader title={kind === "credit" ? "New credit note" : "New invoice"}
        subtitle={kind === "invoice" ? "Batch-tracked stock is picked first expiry, first out. Stock past its use-by date is never invoiced." : "Restocked food goes back into the batch the customer received."}>
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
          <Field label={kind === "invoice" ? "Date (despatch)" : "Date"}><input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
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
            <thead><tr><th style={{ width: "30%" }}>Product</th><th>Description</th><th>Qty</th><th>Unit price</th><th>VAT</th><th className="num">Net</th>{kind === "credit" && <th>Restock</th>}<th /></tr></thead>
            <tbody>
              {lines.map((l, i) => {
                const p = products.find((x) => x.id === l.productId);
                const isTracked = tracked.has(l.productId);
                return (
                  <tr key={i}>
                    <td>
                      <select value={l.productId} aria-label="Product" onChange={(e) => {
                        const np = products.find((x) => x.id === e.target.value);
                        update(i, { productId: e.target.value, batchId: "", description: np?.name ?? l.description, unitPrice: np ? Number(np.sales_price).toFixed(2) : l.unitPrice, vatCode: np?.sales_vat_code ?? l.vatCode });
                      }}>
                        <option value="">No product (service)</option>
                        {products.map((x) => <option key={x.id} value={x.id}>{x.sku} · {x.track_stock ? `${qty(x.on_hand)} in stock` : "service"}</option>)}
                      </select>
                      {kind === "invoice" && isTracked && <AllocationPreview productId={l.productId} quantity={l.quantity} date={date} customerId={customerId} />}
                      {kind === "invoice" && p?.track_stock && !isTracked && Number(l.quantity) > Number(p.on_hand) && <small className="alloc error">Only {qty(p.on_hand)} in stock</small>}
                      {kind === "credit" && isTracked && l.returnToStock && <ReturnBatch productId={l.productId} value={l.batchId} onChange={(v) => update(i, { batchId: v })} />}
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
