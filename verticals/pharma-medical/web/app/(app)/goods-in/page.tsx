"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { qty, today } from "@/lib/format";

interface PoSummary { id: string; number: string; status: string; supplier_name: string; date: string }
interface PoLine { id: string; sku: string; description: string; quantity: string; received_qty: string; product_id: string }
interface PharmaProduct { id: string; batch_tracked: boolean | null }
interface Entry { quantity: string; batchNumber: string; expiry: string; manufacturedOn: string }

const blank = (quantity = ""): Entry => ({ quantity, batchNumber: "", expiry: "", manufacturedOn: "" });

export default function GoodsInPage() {
  const { data: pos } = useApi<PoSummary[]>("/api/purchase-orders");
  const { data: products } = useApi<PharmaProduct[]>("/api/pharma/products");
  const [poId, setPoId] = useState("");
  const { data: po } = useApi<{ number: string; supplier_name: string; lines: PoLine[] }>(poId ? `/api/purchase-orders/${poId}` : null);
  const [receiptDate, setReceiptDate] = useState(today());
  const [entries, setEntries] = useState<Record<string, Entry[]>>({});
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<{ number: string; batches: { id: string; batchNumber: string }[] }>();
  const [busy, setBusy] = useState(false);

  const open = (pos ?? []).filter((p) => ["approved", "part_received"].includes(p.status));
  const tracked = new Set((products ?? []).filter((p) => p.batch_tracked).map((p) => p.id));
  const linesFor = (l: PoLine) => entries[l.id] ?? [blank(String(Number(l.quantity) - Number(l.received_qty)))];
  const setLine = (lineId: string, list: Entry[]) => setEntries({ ...entries, [lineId]: list });

  function choose(id: string) {
    setPoId(id);
    setEntries({});
    setDone(undefined);
    setError(undefined);
  }

  async function submit() {
    if (!po) return;
    setBusy(true);
    setError(undefined);
    try {
      const lines = po.lines.flatMap((l) => linesFor(l).filter((e) => Number(e.quantity) > 0).map((e) => ({
        poLineId: l.id, quantity: e.quantity,
        ...(tracked.has(l.product_id) && { batchNumber: e.batchNumber, expiry: e.expiry, manufacturedOn: e.manufacturedOn || undefined }),
      })));
      setDone(await api("/api/pharma/receipts", { body: { poId, date: receiptDate, lines } }));
      setPoId("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PageHeader title="Goods in (batches)" subtitle="Receive against a purchase order. Batch-tracked lines need a batch number and expiry, and go into quarantine." />
      {done && (
        <div className="notice">
          {done.number} posted. {done.batches.length} batch{done.batches.length === 1 ? "" : "es"} now in quarantine awaiting Responsible Person release:{" "}
          {done.batches.map((b, i) => <span key={b.id}>{i > 0 && ", "}<Link href={`/batches/${b.id}`}>{b.batchNumber}</Link></span>)}
        </div>
      )}
      <ErrorBanner message={error} />
      <Card pad>
        <div className="form-grid">
          <Field label="Purchase order">
            <select value={poId} onChange={(e) => choose(e.target.value)}>
              <option value="">Choose an approved order…</option>
              {open.map((p) => <option key={p.id} value={p.id}>{p.number} · {p.supplier_name}</option>)}
            </select>
          </Field>
          <Field label="Date received"><input type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} /></Field>
        </div>
      </Card>
      {po && (
        <Card title={`${po.number} · ${po.supplier_name}`} pad>
          <div className="stack">
            {po.lines.map((l) => {
              const outstanding = Number(l.quantity) - Number(l.received_qty);
              const list = linesFor(l);
              const isTracked = tracked.has(l.product_id);
              return (
                <div key={l.id} className="stack" style={{ gap: 8 }}>
                  <div><strong>{l.sku}</strong> <span className="muted">{l.description} · {qty(outstanding)} outstanding{isTracked ? " · batch-tracked" : ""}</span></div>
                  {list.map((e, i) => {
                    const update = (patch: Partial<Entry>) => setLine(l.id, list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                    return (
                      <div key={i} className="batch-line">
                        {isTracked ? <Field label="Batch number"><input value={e.batchNumber} onChange={(ev) => update({ batchNumber: ev.target.value })} /></Field> : <span />}
                        <Field label="Quantity"><input className="num" inputMode="decimal" value={e.quantity} onChange={(ev) => update({ quantity: ev.target.value })} /></Field>
                        {isTracked ? <>
                          <Field label="Expiry" hint="YYYY-MM-DD or YYYY-MM"><input placeholder="2028-03" value={e.expiry} onChange={(ev) => update({ expiry: ev.target.value })} /></Field>
                          <Field label="Manufactured"><input type="date" value={e.manufacturedOn} onChange={(ev) => update({ manufacturedOn: ev.target.value })} /></Field>
                        </> : <><span /><span /></>}
                        <span />
                        {list.length > 1
                          ? <button className="btn ghost" onClick={() => setLine(l.id, list.filter((_, j) => j !== i))}>Remove</button>
                          : <span />}
                      </div>
                    );
                  })}
                  {isTracked && <div><button className="btn ghost" onClick={() => setLine(l.id, [...list, blank()])}>Add another batch</button></div>}
                </div>
              );
            })}
            <div className="actions"><button className="btn primary" disabled={busy} onClick={submit}>Post goods received note</button></div>
          </div>
        </Card>
      )}
    </div>
  );
}
