"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Card, DataTable, ErrorBanner, Field, Loading, PageHeader, Status } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date, money, qty, today } from "@/lib/format";

interface Po {
  id: string; number: string; status: string; supplier_id: string; supplier_name: string; warehouse_name: string;
  date: string; expected_date: string | null; currency: string; rate: string; notes: string | null;
  lines: { id: string; sku: string; description: string; quantity: string; unit_price: string; vat_code: string; received_qty: string }[];
  receipts: { id: string; number: string; date: string; line_id: string; quantity: string; value_gbp: string; billed: boolean; shipment_id: string | null; description: string }[];
}

export default function PurchaseOrderPage() {
  const { id } = useParams<{ id: string }>();
  const { data: po, error, reload } = useApi<Po>(`/api/purchase-orders/${id}`);
  const [receiving, setReceiving] = useState<Record<string, string> | null>(null);
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!po) return error ? <ErrorBanner message={error} /> : <div className="card"><Loading /></div>;
  const total = po.lines.reduce((s, l) => s + Number(l.quantity) * Number(l.unit_price), 0);

  async function act(path: string, body: unknown = {}) {
    setBusy(true);
    setActionError(undefined);
    try {
      await api(path, { body });
      setReceiving(null);
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function startReceiving() {
    setReceiving(Object.fromEntries(po!.lines.map((l) => [l.id, String(Number(l.quantity) - Number(l.received_qty))])));
  }

  return (
    <div className="stack">
      <PageHeader title={`Purchase order ${po.number}`} subtitle={<>{po.supplier_name} · <Status value={po.status} /></>}>
        {po.status === "draft" && <>
          <button className="btn ghost" disabled={busy} onClick={() => act(`/api/purchase-orders/${id}/cancel`)}>Cancel order</button>
          <button className="btn primary" disabled={busy} onClick={() => act(`/api/purchase-orders/${id}/approve`)}>Approve</button>
        </>}
        {po.status === "approved" && <button className="btn ghost" disabled={busy} onClick={() => act(`/api/purchase-orders/${id}/cancel`)}>Cancel order</button>}
        {["approved", "part_received"].includes(po.status) && !receiving && <button className="btn primary" onClick={startReceiving}>Receive goods</button>}
        {po.receipts.some((r) => !r.billed) && <Link className="btn" href={`/bills/new?supplierId=${po.supplier_id}`}>Enter supplier bill</Link>}
        {po.receipts.some((r) => !r.shipment_id) && <Link className="btn" href={`/shipments/new?po=${po.id}`}>Add to shipment</Link>}
      </PageHeader>
      <ErrorBanner message={actionError} />
      <div className="grid-main">
        <Card title="Lines">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>SKU</th><th>Description</th><th className="num">Ordered</th><th className="num">Received</th><th className="num">Unit price</th><th className="num">Total</th>{receiving && <th className="num">Receive now</th>}</tr></thead>
              <tbody>
                {po.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.sku}</td><td>{l.description}</td>
                    <td className="num">{qty(l.quantity)}</td>
                    <td className="num">{qty(l.received_qty)}</td>
                    <td className="num">{money(l.unit_price, po.currency)}</td>
                    <td className="num">{money(Number(l.quantity) * Number(l.unit_price), po.currency)}</td>
                    {receiving && (
                      <td className="num" style={{ width: 120 }}>
                        <input className="num" inputMode="decimal" aria-label={`Receive ${l.sku}`} value={receiving[l.id] ?? ""}
                          onChange={(e) => setReceiving({ ...receiving, [l.id]: e.target.value })} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan={5}>Total</td><td className="num">{money(total, po.currency)}</td>{receiving && <td />}</tr></tfoot>
            </table>
          </div>
          {receiving && (
            <form className="card-pad" style={{ borderTop: "1px solid var(--border)", display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" }}
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const lines = Object.entries(receiving).filter(([, q]) => Number(q) > 0).map(([poLineId, quantity]) => ({ poLineId, quantity }));
                void act(`/api/purchase-orders/${id}/receive`, { date: f.get("date"), rate: f.get("rate") || undefined, lines });
              }}>
              <Field label="Received on"><input type="date" name="date" defaultValue={today()} required /></Field>
              {po.currency !== "GBP" && <Field label={`Rate (GBP per ${po.currency})`}><input name="rate" defaultValue={po.rate} className="num" /></Field>}
              <button type="button" className="btn ghost" onClick={() => setReceiving(null)}>Cancel</button>
              <button className="btn primary" disabled={busy}>Post goods received</button>
            </form>
          )}
        </Card>
        <Card title="Details" pad>
          <dl className="meta">
            <dt>Supplier</dt><dd>{po.supplier_name}</dd>
            <dt>Ordered</dt><dd>{date(po.date)}</dd>
            <dt>Expected</dt><dd>{date(po.expected_date)}</dd>
            <dt>Deliver to</dt><dd>{po.warehouse_name}</dd>
            <dt>Currency</dt><dd>{po.currency}{po.currency !== "GBP" && ` @ ${Number(po.rate)}`}</dd>
          </dl>
          {po.notes && <p className="muted">{po.notes}</p>}
        </Card>
      </div>
      <Card title="Goods received">
        <DataTable rows={po.receipts} empty={<p className="muted card-pad">Nothing received yet.</p>} columns={[
          { key: "n", label: "Receipt", render: (r) => r.number },
          { key: "d", label: "Date", render: (r) => date(r.date) },
          { key: "desc", label: "Item", render: (r) => r.description },
          { key: "q", label: "Quantity", num: true, render: (r) => qty(r.quantity) },
          { key: "v", label: "Value (GBP)", num: true, render: (r) => money(r.value_gbp) },
          { key: "b", label: "Billed", render: (r) => r.billed ? <span className="pill quiet ok">Billed</span> : <span className="pill">Awaiting bill</span> },
          { key: "s", label: "Shipment", render: (r) => r.shipment_id ? <Link href={`/shipments/${r.shipment_id}`}>View</Link> : <span className="faint">–</span> },
        ]} />
      </Card>
    </div>
  );
}
