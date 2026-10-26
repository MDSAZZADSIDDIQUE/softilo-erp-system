"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Card, DataTable, ErrorBanner, Field, Loading, PageHeader, Stat, Status } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date, money, qty, today } from "@/lib/format";

interface Shipment {
  id: string; number: string; reference: string | null; mrn: string | null; date: string; status: string; entry_id: string | null;
  lines: { id: string; sku: string; description: string; quantity: string; value_gbp: string; weight_kg: string | null; landed: string; total: string; unit_landed_cost: string }[];
  costs: { id: string; description: string; amount_gbp: string; method: string }[];
}

const METHODS = [
  { id: "value", label: "By value", hint: "Duty, insurance" },
  { id: "weight", label: "By weight", hint: "Freight" },
  { id: "volume", label: "By volume", hint: "Container space" },
  { id: "quantity", label: "By quantity", hint: "Per-unit fees" },
];

export default function ShipmentPage() {
  const { id } = useParams<{ id: string }>();
  const { data: s, error, reload } = useApi<Shipment>(`/api/shipments/${id}`);
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!s) return error ? <ErrorBanner message={error} /> : <div className="card"><Loading /></div>;
  const goods = s.lines.reduce((t, l) => t + Number(l.value_gbp), 0);
  const costs = s.costs.reduce((t, c) => t + Number(c.amount_gbp), 0);
  const open = s.status === "open";

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setActionError(undefined);
    try { await fn(); await reload(); } catch (e) { setActionError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <PageHeader title={`Shipment ${s.number}`} subtitle={<>{s.reference ?? "No container reference"}{s.mrn && <> · MRN <span className="mono">{s.mrn}</span></>} · <Status value={s.status} /></>}>
        {open && (
          <form style={{ display: "flex", gap: 8, alignItems: "center" }} onSubmit={(e) => {
            e.preventDefault();
            const d = new FormData(e.currentTarget).get("date");
            void act(() => api(`/api/shipments/${id}/post`, { body: { date: d } }));
          }}>
            <input type="date" name="date" defaultValue={today()} aria-label="Posting date" style={{ width: 160 }} />
            <button className="btn accent" disabled={busy || !s.costs.length}>Post landed costs</button>
          </form>
        )}
        {s.entry_id && <Link className="btn" href={`/journals/${s.entry_id}`}>View journal</Link>}
      </PageHeader>
      <ErrorBanner message={actionError} />
      <div className="grid-4">
        <Stat label="Goods value" value={money(goods)} sub={`${s.lines.length} lines · arrived ${date(s.date)}`} />
        <Stat label="Landed costs" value={money(costs)} sub={`${s.costs.length} cost lines`} />
        <Stat label="Landed value" value={money(goods + costs)} />
        <Stat label="Uplift on goods" value={goods ? `${((costs / goods) * 100).toFixed(1)}%` : "–"} />
      </div>
      <Card title="Costs" actions={open ? <span className="muted">Post freight and duty bills to Landed cost clearing (2110) first</span> : undefined}>
        <DataTable rows={s.costs} empty={<p className="muted card-pad" style={{ margin: 0 }}>No costs added yet.</p>} columns={[
          { key: "d", label: "Cost", render: (c) => c.description },
          { key: "m", label: "Spread", render: (c) => METHODS.find((m) => m.id === c.method)?.label ?? c.method },
          { key: "a", label: "Amount", num: true, render: (c) => money(c.amount_gbp) },
          ...(open ? [{ key: "x", label: "", render: (c: Shipment["costs"][number]) => (
            <button className="btn ghost small" disabled={busy} onClick={() => act(() => api(`/api/shipments/${id}/costs/${c.id}`, { method: "DELETE" }))}>Remove</button>
          ) }] : []),
        ]} />
        {open && (
          <form className="card-pad" style={{ borderTop: "1px solid var(--border)", display: "grid", gridTemplateColumns: "2fr 1fr 1fr auto", gap: 12, alignItems: "end" }}
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const f = Object.fromEntries(new FormData(form));
              void act(async () => { await api(`/api/shipments/${id}/costs`, { body: f }); form.reset(); });
            }}>
            <Field label="Description"><input name="description" placeholder="Sea freight" required /></Field>
            <Field label="Amount (£)"><input name="amountGbp" className="num" inputMode="decimal" required /></Field>
            <Field label="Spread">
              <select name="method" defaultValue="value">{METHODS.map((m) => <option key={m.id} value={m.id}>{m.label} — {m.hint}</option>)}</select>
            </Field>
            <button className="btn" disabled={busy}>Add cost</button>
          </form>
        )}
      </Card>
      <Card title={open ? "Allocation preview" : "Landed cost by line"}>
        <DataTable rows={s.lines} columns={[
          { key: "sku", label: "SKU", render: (l) => l.sku },
          { key: "d", label: "Item", render: (l) => l.description },
          { key: "q", label: "Qty", num: true, render: (l) => qty(l.quantity) },
          { key: "w", label: "Weight", num: true, render: (l) => l.weight_kg ? `${(Number(l.weight_kg) * Number(l.quantity)).toLocaleString("en-GB")} kg` : "–" },
          { key: "g", label: "Goods", num: true, render: (l) => money(l.value_gbp) },
          { key: "l", label: "Landed costs", num: true, render: (l) => money(l.landed) },
          { key: "t", label: "Total", num: true, render: (l) => money(l.total) },
          { key: "u", label: "Unit landed cost", num: true, render: (l) => <strong style={{ fontWeight: 500 }}>£{Number(l.unit_landed_cost).toFixed(4)}</strong> },
        ]} footer={<tr><td colSpan={4}>Total</td><td className="num">{money(goods)}</td><td className="num">{money(costs)}</td><td className="num">{money(goods + costs)}</td><td /></tr>} />
      </Card>
    </div>
  );
}
