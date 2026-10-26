"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, DataTable, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { useContacts, useProducts } from "@/components/pickers";
import { api, useApi } from "@/lib/api";
import { date, money, qty, today } from "@/lib/format";

interface Line { productId: string; quantity: string; unitPrice: string }
interface Preview {
  ok: boolean; customer: string; minShelfLifeDays: number;
  licences: { type: string; number: string; verifiedOn: string }[];
  plan: { productId: string; sku: string; name: string; tracked: boolean; quantity: string; error?: string;
    allocations: { batchId: string; batchNumber: string; expiry: string; quantity: string }[] }[];
}
interface Dispatch { id: string; date: string; invoice_id: string; invoice_number: string; customer_name: string; units: string; total: string; currency: string }

export default function DispatchPage() {
  const customers = useContacts("customer");
  const products = useProducts();
  const { data: recent, reload } = useApi<Dispatch[]>("/api/pharma/dispatches");
  const [customerId, setCustomerId] = useState("");
  const [supplyDate, setSupplyDate] = useState(today());
  const [lines, setLines] = useState<Line[]>([{ productId: "", quantity: "", unitPrice: "" }]);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<{ invoiceId: string; invoiceNumber: string }>();
  const [busy, setBusy] = useState(false);

  const filled = lines.filter((l) => l.productId && Number(l.quantity) > 0);
  const update = (i: number, patch: Partial<Line>) => {
    setPreview(undefined);
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  };

  async function run<T>(fn: () => Promise<T>) {
    setBusy(true);
    setError(undefined);
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const check = () => run(async () => setPreview(await api<Preview>("/api/pharma/allocation-preview", {
    body: { customerId, date: supplyDate, lines: filled.map(({ productId, quantity }) => ({ productId, quantity })) },
  })));

  const dispatch = () => run(async () => {
    const r = await api("/api/pharma/dispatches", { body: { customerId, date: supplyDate, lines: filled } });
    setDone(r);
    setPreview(undefined);
    setLines([{ productId: "", quantity: "", unitPrice: "" }]);
    await reload();
  });

  return (
    <div className="stack">
      <PageHeader title="Dispatch (FEFO)" subtitle="Checks the customer's licence, then allocates released, in-date batches first-expiry-first-out and raises the invoice" />
      {done && <div className="notice">Dispatched and invoiced as <Link href={`/invoices/${done.invoiceId}`}>{done.invoiceNumber}</Link>.</div>}
      <ErrorBanner message={error} />
      <Card pad>
        <div className="stack">
          <div className="form-grid">
            <Field label="Customer">
              <select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setPreview(undefined); }}>
                <option value="">Choose customer…</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Dispatch date"><input type="date" value={supplyDate} onChange={(e) => { setSupplyDate(e.target.value); setPreview(undefined); }} /></Field>
          </div>
          {lines.map((l, i) => (
            <div key={i} className="grid-3">
              <Field label="Product">
                <select value={l.productId} onChange={(e) => {
                  const p = products.find((x) => x.id === e.target.value);
                  update(i, { productId: e.target.value, unitPrice: p ? String(Number(p.sales_price)) : "" });
                }}>
                  <option value="">Choose product…</option>
                  {products.filter((p) => p.track_stock).map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}
                </select>
              </Field>
              <Field label="Quantity"><input className="num" inputMode="decimal" value={l.quantity} onChange={(e) => update(i, { quantity: e.target.value })} /></Field>
              <Field label="Unit price (£, ex VAT)"><input className="num" inputMode="decimal" value={l.unitPrice} onChange={(e) => update(i, { unitPrice: e.target.value })} /></Field>
            </div>
          ))}
          <div className="actions">
            <button className="btn ghost" onClick={() => setLines([...lines, { productId: "", quantity: "", unitPrice: "" }])}>Add line</button>
            <button className="btn" disabled={busy || !customerId || !filled.length} onClick={check}>Check licence &amp; allocate</button>
            <button className="btn primary" disabled={busy || !preview?.ok} onClick={dispatch}>Dispatch &amp; invoice</button>
          </div>
        </div>
      </Card>
      {preview && (
        <Card title={preview.ok ? "Ready to dispatch" : "Cannot dispatch yet"} pad>
          <div className="stack">
            <div className="muted">
              {preview.licences.length
                ? <>Relying on {preview.licences.map((l) => `${l.number} (verified ${date(l.verifiedOn)})`).join(", ")}.</>
                : "No licence needed for these lines."}
              {preview.minShelfLifeDays > 0 && <> Customer requires at least {preview.minShelfLifeDays} days of shelf life.</>}
            </div>
            {preview.plan.map((p) => (
              <div key={p.productId}>
                <strong>{p.sku}</strong> <span className="muted">{p.name} · {qty(p.quantity)}</span>
                {p.error ? <div className="banner error" role="alert">{p.error}</div>
                  : !p.tracked ? <div className="muted">Not batch-tracked.</div>
                  : <ul>{p.allocations.map((a) => <li key={a.batchId}><span className="mono">{a.batchNumber}</span> · {qty(a.quantity)} · expires {date(a.expiry)}</li>)}</ul>}
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card title="Recent dispatches">
        <DataTable rows={recent} href={(d) => `/invoices/${d.invoice_id}`} empty={<div className="empty"><strong>No dispatches yet</strong></div>} columns={[
          { key: "date", label: "Date", render: (d) => date(d.date) },
          { key: "inv", label: "Invoice", render: (d) => d.invoice_number },
          { key: "cust", label: "Customer", render: (d) => d.customer_name },
          { key: "units", label: "Units", num: true, render: (d) => qty(d.units) },
          { key: "total", label: "Total", num: true, render: (d) => money(d.total, d.currency) },
        ]} />
      </Card>
    </div>
  );
}
