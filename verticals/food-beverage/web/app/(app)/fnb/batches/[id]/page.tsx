"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { Card, DataTable, ErrorBanner, Field, Loading, PageHeader } from "@core/components/ui";
import { api, useApi } from "@core/lib/api";
import { date, dateTime, qty, today } from "@core/lib/format";
import { DateMark, ExpiryPill } from "@/components/fnb";
import { documentLink, KIND, TraceView, type Trace } from "@/components/trace";

export default function BatchPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, reload } = useApi<Trace>(`/api/fnb/batches/${id}`);
  const [writingOff, setWritingOff] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!data) return error ? <ErrorBanner message={error} /> : <div className="card"><Loading /></div>;
  const { batch } = data;

  async function writeOff(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    setActionError(undefined);
    try {
      await api(`/api/fnb/batches/${id}/write-off`, { body: { date: f.date, quantity: f.quantity, reason: f.reason } });
      setWritingOff(false);
      await reload();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PageHeader title={`Batch ${batch.code}`} subtitle={<>{batch.sku} · {batch.product_name} · <DateMark expiry={batch.expiry} type={batch.date_type} /> · <ExpiryPill status={batch.status} /></>}>
        <span className="no-print" style={{ display: "contents" }}>
          {Number(data.totals.onHand) > 0 && !writingOff && <button className="btn" onClick={() => setWritingOff(true)}>Write off stock</button>}
          <button className="btn primary" onClick={() => window.print()}>Print recall trace</button>
        </span>
      </PageHeader>
      <ErrorBanner message={actionError} />
      {writingOff && (
        <Card title="Write off stock from this batch" pad>
          <form className="form-grid" onSubmit={writeOff}>
            <Field label="Date"><input type="date" name="date" defaultValue={today()} required /></Field>
            <Field label="Quantity" hint={`${qty(data.totals.onHand)} on hand`}><input name="quantity" className="num" inputMode="decimal" defaultValue={Number(data.totals.onHand)} required /></Field>
            <Field label="Reason"><input name="reason" defaultValue={batch.status === "expired" ? "Past use-by date" : ""} required /></Field>
            <div className="actions" style={{ alignSelf: "end" }}>
              <button type="button" className="btn ghost" onClick={() => setWritingOff(false)}>Cancel</button>
              <button className="btn primary" disabled={busy}>Post write-off</button>
            </div>
          </form>
          <p className="muted" style={{ marginBottom: 0 }}>Posts the stock value at average cost to 5050 Stock waste and write-offs.</p>
        </Card>
      )}
      <TraceView trace={data} />
      <Card title="Movements">
        <DataTable rows={data.movements} columns={[
          { key: "d", label: "Date", render: (m) => date(m.date) },
          { key: "k", label: "Movement", render: (m) => KIND[m.kind] ?? m.kind },
          { key: "doc", label: "Document", render: documentLink },
          { key: "c", label: "Customer / supplier", render: (m) => m.contact_name ?? <span className="faint">–</span> },
          { key: "w", label: "Warehouse", render: (m) => m.warehouse },
          { key: "q", label: "Quantity", num: true, render: (m) => qty(m.quantity) },
        ]} />
      </Card>
      <p className="faint" style={{ fontSize: 12 }}>Trace generated {dateTime(new Date().toISOString())}.</p>
    </div>
  );
}
