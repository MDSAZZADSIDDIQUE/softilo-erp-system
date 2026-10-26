"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Card, DataTable, ErrorBanner, Field, Loading, PageHeader } from "@/components/ui";
import { BatchStatus, ExpiryBand } from "@/components/pharma";
import { api, useApi } from "@/lib/api";
import { date, dateTime, qty } from "@/lib/format";

interface Batch {
  id: string; product_id: string; sku: string; product_name: string; batch_number: string; expiry: string; band: string;
  manufactured_on: string | null; status: string; on_hand: string; received_qty: string; received_on: string;
  supplier_name: string; warehouse_name: string; receipt_number: string; po_number: string;
  actions: string[]; canDecide: boolean;
  events: { id: string; action: string; from_status: string | null; to_status: string; reason: string | null; reference: string | null;
    decided_by_name: string; decided_at: string }[];
  movements: { id: string; date: string; kind: string; quantity: string; invoice_number: string | null; customer_name: string | null }[];
}

const ACTION_LABEL: Record<string, string> = { release: "Release for sale", reject: "Reject", quarantine: "Return to quarantine", recall: "Recall" };
const EVENT_LABEL: Record<string, string> = { receive: "Received into quarantine", release: "Released", reject: "Rejected", quarantine: "Returned to quarantine", recall: "Recalled" };

export default function BatchPage() {
  const { id } = useParams<{ id: string }>();
  const { data: b, error, reload } = useApi<Batch>(`/api/pharma/batches/${id}`);
  const [action, setAction] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!b) return error ? <ErrorBanner message={error} /> : <div className="card"><Loading /></div>;

  async function decide() {
    setBusy(true);
    setActionError(undefined);
    try {
      await api(`/api/pharma/batches/${id}/${action}`, { body: { reason: reason || undefined, reference: reference || undefined } });
      setAction(null);
      setReason("");
      setReference("");
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PageHeader title={`Batch ${b.batch_number}`} subtitle={<>{b.sku} · {b.product_name} · <BatchStatus value={b.status} /></>}>
        <Link className="btn" href={`/recalls?productId=${b.product_id}&batch=${encodeURIComponent(b.batch_number)}`}>Trace</Link>
        {b.canDecide && !action && b.actions.map((a) => (
          <button key={a} className={`btn${a === "release" ? " primary" : ""}`} onClick={() => setAction(a)}>{ACTION_LABEL[a]}</button>
        ))}
      </PageHeader>
      {!b.canDecide && b.actions.length > 0 && (
        <div className="notice">Only a named Responsible Person can release, reject or recall this batch.</div>
      )}
      <ErrorBanner message={actionError} />
      {action && (
        <Card title={`${ACTION_LABEL[action]}: Responsible Person decision`} pad>
          <div className="form-grid">
            <Field label={action === "release" ? "Note (optional)" : "Reason"} hint="Recorded with your name and the time in the batch history and audit trail">
              <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            {action === "recall" && (
              <Field label="Alert or recall reference" hint="e.g. the MHRA drug alert number">
                <input value={reference} onChange={(e) => setReference(e.target.value)} />
              </Field>
            )}
          </div>
          <div className="actions" style={{ marginTop: 12 }}>
            <button className="btn ghost" onClick={() => setAction(null)}>Cancel</button>
            <button className="btn primary" disabled={busy} onClick={decide}>Confirm {ACTION_LABEL[action]!.toLowerCase()}</button>
          </div>
        </Card>
      )}
      <div className="grid-main">
        <div className="stack">
          <Card title="Movements">
            <DataTable rows={b.movements} columns={[
              { key: "date", label: "Date", render: (m) => date(m.date) },
              { key: "kind", label: "Movement", render: (m) => m.kind === "dispatch" ? <>Dispatched to {m.customer_name} <span className="muted">{m.invoice_number}</span></> : `Received on ${b.receipt_number}` },
              { key: "qty", label: "Quantity", num: true, render: (m) => qty(m.quantity) },
            ]} />
          </Card>
          <Card title="Status history" pad>
            <ol className="timeline">
              {b.events.map((e) => (
                <li key={e.id}>
                  <strong>{EVENT_LABEL[e.action]}</strong> <span className="muted">by {e.decided_by_name}, {dateTime(e.decided_at)}</span>
                  {e.reason && <div>{e.reason}</div>}
                  {e.reference && <div className="muted">Reference {e.reference}</div>}
                </li>
              ))}
            </ol>
          </Card>
        </div>
        <Card title="Details" pad>
          <dl className="stack" style={{ gap: 10, margin: 0 }}>
            <div><dt className="muted">Expiry</dt><dd>{date(b.expiry)} <ExpiryBand band={b.band} /></dd></div>
            {b.manufactured_on && <div><dt className="muted">Manufactured</dt><dd>{date(b.manufactured_on)}</dd></div>}
            <div><dt className="muted">On hand</dt><dd className="mono">{qty(b.on_hand)} of {qty(b.received_qty)} received</dd></div>
            <div><dt className="muted">Warehouse</dt><dd>{b.warehouse_name}</dd></div>
            <div><dt className="muted">Supplier</dt><dd>{b.supplier_name}</dd></div>
            <div><dt className="muted">Received</dt><dd>{date(b.received_on)} on {b.receipt_number} ({b.po_number})</dd></div>
          </dl>
        </Card>
      </div>
    </div>
  );
}
