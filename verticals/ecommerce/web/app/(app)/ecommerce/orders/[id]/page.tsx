"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Card, DataTable, ErrorBanner, Field, PageHeader, paymentStatus, Status } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date, money, qty, today } from "@/lib/format";
import { CHANNEL_LABEL, margin } from "@ecom/components/ecom";

interface Line { id: string; description: string; sku: string | null; quantity: string; unit_price: string; net: string; vat: string; vat_code: string; cost_gbp: string; product_id: string | null; returned_qty: string }
interface Return { id: string; number: string; received_date: string; refund_due_by: string; refund: string; deduction: string; reason: string | null; credit_note_number: string; refunded: boolean }
interface Order {
  id: string; order_number: string; date: string; customer_name: string; customer_email: string | null; ship_country: string | null;
  vat_treatment: string; total: string; channel_name: string; channel_kind: string; invoice_id: string; invoice_number: string;
  amount_paid: string; invoice_total: string; net: string; cost: string; outstanding: string; lines: Line[]; returns: Return[]; payouts: { id: string; number: string; date: string }[];
}

const TREATMENT: Record<string, string> = { seller: "UK VAT charged by us", marketplace: "VAT collected by the marketplace", export: "Export (zero-rated)" };

export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const { data: o, error, reload } = useApi<Order>(`/api/ecommerce/orders/${id}`);
  const [form, setForm] = useState<Record<string, { quantity: string; disposition: string }>>({});
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  if (!o) return <div className="stack"><PageHeader title="Order" /><ErrorBanner message={error} /></div>;
  const goods = o.lines.filter((l) => l.product_id);
  const m = margin(o.net, o.cost);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const lines = Object.entries(form).filter(([, v]) => Number(v.quantity) > 0)
      .map(([invoiceLineId, v]) => ({ invoiceLineId, quantity: v.quantity, disposition: v.disposition }));
    setBusy(true);
    try {
      await api(`/api/ecommerce/orders/${id}/returns`, {
        body: { receivedDate: f.receivedDate, reason: f.reason || undefined, lines, refundDelivery: f.refundDelivery === "on", deduction: f.deduction || undefined },
      });
      setForm({});
      setOpen(false);
      setFormError(undefined);
      await reload();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const returnable = goods.some((l) => Number(l.returned_qty) < Number(l.quantity));
  return (
    <div className="stack">
      <PageHeader title={`Order ${o.order_number}`} subtitle={`${o.channel_name} (${CHANNEL_LABEL[o.channel_kind] ?? o.channel_kind}) · ${date(o.date)} · ${o.customer_name}`}>
        <Link className="btn ghost" href={`/invoices/${o.invoice_id}`}>Invoice {o.invoice_number}</Link>
        {returnable && <button className="btn primary" onClick={() => setOpen((x) => !x)}>{open ? "Cancel return" : "Record a return"}</button>}
      </PageHeader>
      <ErrorBanner message={error} />
      <div className="grid-4">
        <div className="card stat"><div className="label">Order total</div><div className="value">{money(o.total)}</div></div>
        <div className="card stat"><div className="label">Margin</div><div className="value">{money(m.value)}</div><div className="sub">{m.pct} of net sales after returns, before fees</div></div>
        <div className="card stat"><div className="label">Payout</div><div className="value"><Status value={paymentStatus({ total: o.invoice_total, amount_paid: o.amount_paid })} /></div>
          <div className="sub">{o.payouts.map((p) => <Link key={p.id} href={`/ecommerce/payouts/${p.id}`}>{p.number} </Link>)}</div></div>
        <div className="card stat"><div className="label">VAT</div><div className="value" style={{ fontSize: 16 }}>{TREATMENT[o.vat_treatment]}</div><div className="sub">Ships to {o.ship_country ?? "–"}</div></div>
      </div>

      {open && (
        <form onSubmit={submit}>
          <Card title="Record a return" pad>
            <div className="stack" style={{ gap: 16 }}>
              <ErrorBanner message={formError} />
              <p className="muted" style={{ margin: 0 }}>
                Choose what came back and whether it can be sold again. The refund is due within 14 days of the goods
                coming back (Consumer Contracts Regulations 2013). Refund the original delivery charge when the whole order is returned.
              </p>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Item</th><th className="num">Sold</th><th className="num">Already returned</th><th className="num">Returning</th><th>Condition</th></tr></thead>
                  <tbody>
                    {goods.map((l) => {
                      const left = Number(l.quantity) - Number(l.returned_qty);
                      const v = form[l.id] ?? { quantity: "", disposition: "restock" };
                      return (
                        <tr key={l.id}>
                          <td>{l.description} <span className="faint">{l.sku}</span></td>
                          <td className="num">{qty(l.quantity)}</td>
                          <td className="num">{qty(l.returned_qty)}</td>
                          <td className="num"><input type="number" min={0} max={left} step={1} disabled={left <= 0} value={v.quantity} style={{ width: 80 }}
                            aria-label={`Quantity of ${l.description} returned`}
                            onChange={(e) => setForm({ ...form, [l.id]: { ...v, quantity: e.target.value } })} /></td>
                          <td><select value={v.disposition} disabled={left <= 0} aria-label={`Condition of ${l.description}`}
                            onChange={(e) => setForm({ ...form, [l.id]: { ...v, disposition: e.target.value } })}>
                            <option value="restock">Resaleable: back to stock</option>
                            <option value="write_off">Damaged: write off</option>
                          </select></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="form-grid">
                <Field label="Goods received back"><input type="date" name="receivedDate" defaultValue={today()} required /></Field>
                <Field label="Reason"><input name="reason" placeholder="e.g. Arrived damaged" /></Field>
                <Field label="Deduction for diminished value" hint="Only for handling beyond inspecting the goods"><input name="deduction" inputMode="decimal" placeholder="0.00" /></Field>
                <label className="checkbox"><input type="checkbox" name="refundDelivery" /> Refund the original delivery charge</label>
              </div>
              <div className="actions"><button className="btn primary" disabled={busy}>Record return and refund</button></div>
            </div>
          </Card>
        </form>
      )}

      <Card title="Lines">
        <DataTable rows={o.lines} columns={[
          { key: "d", label: "Item", render: (l) => <>{l.description} {l.sku && <span className="faint">{l.sku}</span>}</> },
          { key: "q", label: "Qty", num: true, render: (l) => qty(l.quantity) },
          { key: "n", label: "Net", num: true, render: (l) => money(l.net) },
          { key: "v", label: "VAT", num: true, render: (l) => <>{money(l.vat)} <span className="faint">{l.vat_code}</span></> },
          { key: "c", label: "Cost", num: true, render: (l) => money(l.cost_gbp) },
          { key: "r", label: "Returned", num: true, render: (l) => Number(l.returned_qty) ? qty(l.returned_qty) : "–" },
        ]} />
      </Card>

      {o.returns.length > 0 && (
        <Card title="Returns">
          <DataTable rows={o.returns} columns={[
            { key: "n", label: "Return", render: (r) => r.number },
            { key: "d", label: "Received", render: (r) => date(r.received_date) },
            { key: "cn", label: "Credit note", render: (r) => r.credit_note_number },
            { key: "due", label: "Refund due by", render: (r) => date(r.refund_due_by) },
            { key: "s", label: "Status", render: (r) => <span className={`pill ${r.refunded ? "quiet ok" : ""}`}>{r.refunded ? "Refunded" : "Awaiting payout"}</span> },
            { key: "x", label: "Deduction", num: true, render: (r) => Number(r.deduction) ? money(r.deduction) : "–" },
            { key: "a", label: "Refund", num: true, render: (r) => money(r.refund) },
          ]} />
        </Card>
      )}
    </div>
  );
}
