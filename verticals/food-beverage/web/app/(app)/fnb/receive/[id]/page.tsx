"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Card, ErrorBanner, Field, Loading, PageHeader } from "@core/components/ui";
import { api, useApi } from "@core/lib/api";
import { qty, today } from "@core/lib/format";
import { dateTypeLabel } from "@/components/fnb";

interface Po {
  id: string; number: string; status: string; supplier_name: string; currency: string; rate: string;
  lines: { id: string; product_id: string; sku: string; description: string; quantity: string; received_qty: string }[];
}
interface FoodProduct { id: string; batch_tracked: boolean; date_type: string | null; shelf_life_days: number | null; storage: string | null }
interface Row { key: number; poLineId: string; quantity: string; batchCode: string; expiry: string }

let nextKey = 1;

/** Goods received with a batch code and date mark per line. A line delivered in two lots is split into two rows. */
export default function ReceiveBatchesPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: po, error } = useApi<Po>(`/api/purchase-orders/${id}`);
  const { data: food } = useApi<FoodProduct[]>("/api/fnb/products");
  const [rows, setRows] = useState<Row[]>([]);
  const [date, setDate] = useState(today());
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!po) return;
    setRows(po.lines
      .filter((l) => Number(l.quantity) > Number(l.received_qty))
      .map((l) => ({ key: nextKey++, poLineId: l.id, quantity: String(Number(l.quantity) - Number(l.received_qty)), batchCode: "", expiry: "" })));
  }, [po]);

  if (!po || !food) return error ? <ErrorBanner message={error} /> : <div className="card"><Loading /></div>;
  const settings = new Map(food.filter((p) => p.batch_tracked).map((p) => [p.id, p]));
  const lineOf = (r: Row) => po.lines.find((l) => l.id === r.poLineId)!;
  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    setActionError(undefined);
    try {
      await api(`/api/fnb/purchase-orders/${id}/receive`, {
        body: {
          date, rate: f.rate || undefined,
          lines: rows.filter((r) => Number(r.quantity) > 0).map((r) => ({
            poLineId: r.poLineId, quantity: r.quantity, batchCode: r.batchCode.trim() || undefined, expiry: r.expiry || undefined,
          })),
        },
      });
      router.push(`/purchase-orders/${id}`);
    } catch (err) {
      setActionError((err as Error).message);
      setBusy(false);
    }
  }

  if (!["approved", "part_received"].includes(po.status)) {
    return <ErrorBanner message={`Purchase order ${po.number} is ${po.status.replace("_", " ")}; approve it before receiving goods.`} />;
  }

  return (
    <form className="stack" onSubmit={submit}>
      <PageHeader title={`Receive ${po.number}`} subtitle={`${po.supplier_name} · Enter the batch code and date printed on each delivery. Reject anything already past its use-by date.`}>
        <button type="button" className="btn ghost" onClick={() => router.back()}>Cancel</button>
        <button className="btn primary" disabled={busy || rows.length === 0}>Post goods received</button>
      </PageHeader>
      <ErrorBanner message={actionError} />
      <Card pad>
        <div className="form-grid">
          <Field label="Received on"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
          {po.currency !== "GBP" && <Field label={`Rate (GBP per ${po.currency})`}><input name="rate" defaultValue={po.rate} className="num" /></Field>}
        </div>
      </Card>
      <Card title="Lines">
        <div className="table-wrap card-pad">
          <table className="lines">
            <thead><tr><th>Product</th><th className="num">Outstanding</th><th>Receive</th><th>Batch code</th><th>Date mark</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => {
                const l = lineOf(r);
                const s = settings.get(l.product_id);
                return (
                  <tr key={r.key}>
                    <td>{l.sku} <span className="muted">· {l.description}</span>{s && <small className="alloc">{dateTypeLabel(s.date_type)}{s.storage && s.storage !== "ambient" ? ` · ${s.storage}` : ""}</small>}</td>
                    <td className="num">{qty(Number(l.quantity) - Number(l.received_qty))}</td>
                    <td style={{ width: 110 }}><input className="num" inputMode="decimal" aria-label={`Quantity of ${l.sku}`} value={r.quantity} onChange={(e) => update(r.key, { quantity: e.target.value })} /></td>
                    <td style={{ width: 170 }}>
                      {s ? <input aria-label={`Batch code for ${l.sku}`} value={r.batchCode} required onChange={(e) => update(r.key, { batchCode: e.target.value })} />
                        : <span className="faint">Not batch-tracked</span>}
                    </td>
                    <td style={{ width: 170 }}>
                      {s ? <input type="date" aria-label={`Date mark for ${l.sku}`} value={r.expiry} required={s.date_type === "use_by" && s.shelf_life_days === null}
                        onChange={(e) => update(r.key, { expiry: e.target.value })} /> : null}
                      {s && !r.expiry && s.shelf_life_days !== null && <small className="alloc">Blank: {s.shelf_life_days} days from receipt</small>}
                    </td>
                    <td>
                      {s && <button type="button" className="btn ghost small" onClick={() => setRows((rs) => {
                        const i = rs.findIndex((x) => x.key === r.key);
                        return [...rs.slice(0, i + 1), { key: nextKey++, poLineId: r.poLineId, quantity: "0", batchCode: "", expiry: "" }, ...rs.slice(i + 1)];
                      })}>Another batch</button>}
                      <button type="button" className="btn ghost small" aria-label="Remove row" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && <p className="muted">Everything on this order has been received.</p>}
        </div>
      </Card>
    </form>
  );
}
