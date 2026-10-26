"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useContacts, useProducts, VatSelect } from "@/components/pickers";
import { Card, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { money, roundHalfUp, sumPence, today } from "@/lib/format";

interface Line { productId: string; quantity: string; unitPrice: string; vatCode: string }
const blank = (): Line => ({ productId: "", quantity: "1", unitPrice: "", vatCode: "OS" });

export default function NewPurchaseOrderPage() {
  const router = useRouter();
  const suppliers = useContacts("supplier");
  const products = useProducts().filter((p) => p.track_stock);
  const { data: warehouses } = useApi<{ id: string; name: string }[]>("/api/warehouses");
  const [supplierId, setSupplierId] = useState("");
  const supplier = suppliers.find((s) => s.id === supplierId);
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const currency = supplier?.currency ?? "GBP";

  const update = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const lineTotal = (l: Line) => roundHalfUp(Number(l.quantity || 0) * Number(l.unitPrice || 0));
  const total = sumPence(lines.map(lineTotal));

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    try {
      const { id } = await api("/api/purchase-orders", {
        body: {
          supplierId, date: f.date, expectedDate: f.expectedDate || undefined, warehouseId: f.warehouseId || undefined,
          rate: currency === "GBP" ? undefined : f.rate, notes: f.notes || undefined,
          lines: lines.filter((l) => l.productId).map((l) => ({ ...l })),
        },
      });
      router.push(`/purchase-orders/${id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <PageHeader title="New purchase order">
        <button type="button" className="btn ghost" onClick={() => router.back()}>Cancel</button>
        <button className="btn primary" disabled={busy || !supplierId}>Save as draft</button>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card title="Order" pad>
        <div className="form-grid">
          <Field label="Supplier">
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
              <option value="">Choose supplier…</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.currency})</option>)}
            </select>
          </Field>
          <Field label="Order date"><input type="date" name="date" defaultValue={today()} required /></Field>
          <Field label="Expected delivery"><input type="date" name="expectedDate" /></Field>
          <Field label="Deliver to">
            <select name="warehouseId">{warehouses?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
          </Field>
          {currency !== "GBP" && (
            <Field label={`Exchange rate (GBP per 1 ${currency})`} hint="Used to value stock on receipt">
              <input name="rate" inputMode="decimal" className="num" required placeholder="0.79" />
            </Field>
          )}
        </div>
      </Card>
      <Card title={`Lines (${currency})`}>
        <div className="table-wrap card-pad">
          <table className="lines">
            <thead><tr><th style={{ width: "40%" }}>Product</th><th>Quantity</th><th>Unit price</th><th>VAT</th><th className="num">Total</th><th /></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    <select value={l.productId} aria-label="Product" onChange={(e) => {
                      const p = products.find((x) => x.id === e.target.value);
                      update(i, { productId: e.target.value, vatCode: currency === "GBP" ? (p?.purchase_vat_code ?? "S20") : "OS" });
                    }}>
                      <option value="">Choose product…</option>
                      {products.map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}
                    </select>
                  </td>
                  <td><input className="num" inputMode="decimal" aria-label="Quantity" value={l.quantity} onChange={(e) => update(i, { quantity: e.target.value })} /></td>
                  <td><input className="num" inputMode="decimal" aria-label="Unit price" value={l.unitPrice} onChange={(e) => update(i, { unitPrice: e.target.value })} /></td>
                  <td><VatSelect value={l.vatCode} onChange={(v) => update(i, { vatCode: v })} /></td>
                  <td className="num">{money(lineTotal(l), currency)}</td>
                  <td><button type="button" className="btn ghost small" aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} disabled={lines.length === 1}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="btn small" style={{ marginTop: 12 }} onClick={() => setLines((ls) => [...ls, blank()])}>Add line</button>
        </div>
        <div className="totals"><span className="grand">Total</span><span className="grand">{money(total, currency)}</span></div>
      </Card>
      <Card title="Notes" pad><textarea name="notes" aria-label="Notes" style={{ minHeight: 80 }} /></Card>
    </form>
  );
}
