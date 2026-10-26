"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Card, Empty, ErrorBanner, Field, Loading, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date, money, qty, today } from "@/lib/format";

interface Line { id: string; receipt_number: string; date: string; po_id: string; po_number: string; supplier_name: string; sku: string; description: string; quantity: string; value_gbp: string }

export default function NewShipmentPage() {
  const router = useRouter();
  const poFilter = useSearchParams().get("po");
  const { data } = useApi<Line[]>("/api/goods-receipts/unshipped");
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const selected = picked ?? new Set((data ?? []).filter((l) => l.po_id === poFilter).map((l) => l.id));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
  };
  const value = (data ?? []).filter((l) => selected.has(l.id)).reduce((s, l) => s + Number(l.value_gbp), 0);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    try {
      const { id } = await api("/api/shipments", {
        body: { reference: f.reference || undefined, mrn: f.mrn || undefined, date: f.date, receiptLineIds: [...selected] },
      });
      router.push(`/shipments/${id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <PageHeader title="New shipment">
        <button type="button" className="btn ghost" onClick={() => router.back()}>Cancel</button>
        <button className="btn primary" disabled={busy || !selected.size}>Create shipment</button>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card title="Shipment" pad>
        <div className="form-grid">
          <Field label="Container or bill of lading"><input name="reference" placeholder="MSCU1234567" /></Field>
          <Field label="Customs entry (MRN)" hint="Matches the PVA statement to this shipment"><input name="mrn" placeholder="26GB…" /></Field>
          <Field label="Arrival date"><input type="date" name="date" defaultValue={today()} required /></Field>
        </div>
      </Card>
      <Card title="Goods on this shipment" actions={<span className="muted">{selected.size} lines · {money(value)}</span>}>
        {!data ? <Loading /> : !data.length ? <Empty title="Nothing to add">All received goods are already on a shipment.</Empty> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th /><th>Receipt</th><th>PO</th><th>Supplier</th><th>Item</th><th className="num">Qty</th><th className="num">Value</th></tr></thead>
              <tbody>
                {data.map((l) => (
                  <tr key={l.id} className="clickable" onClick={(e) => { if ((e.target as HTMLElement).tagName !== "INPUT") toggle(l.id); }}>
                    <td><input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} aria-label={`Include ${l.sku}`} /></td>
                    <td>{l.receipt_number} <span className="faint">{date(l.date)}</span></td>
                    <td>{l.po_number}</td><td>{l.supplier_name}</td><td>{l.sku} · {l.description}</td>
                    <td className="num">{qty(l.quantity)}</td><td className="num">{money(l.value_gbp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </form>
  );
}
