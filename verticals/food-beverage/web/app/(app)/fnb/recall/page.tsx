"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, Field, PageHeader } from "@core/components/ui";
import { api, useApi } from "@core/lib/api";
import { dateTime, qty } from "@core/lib/format";
import { DateMark, ExpiryPill, type BatchStatus } from "@/components/fnb";
import { TraceView, type Trace } from "@/components/trace";

interface Batch { id: string; code: string; sku: string; product_name: string; expiry: string | null; date_type: string; status: BatchStatus; on_hand: string }

/**
 * Recall trace. A supplier, the FSA or a customer quotes a product and batch code: find who received it, in minutes.
 */
export default function RecallPage() {
  const [search, setSearch] = useState("");
  const { data: batches } = useApi<Batch[]>(search.trim().length >= 2 ? `/api/fnb/batches?search=${encodeURIComponent(search.trim())}` : null);
  const [trace, setTrace] = useState<Trace>();
  const [error, setError] = useState<string>();

  async function open(id: string) {
    setError(undefined);
    try {
      setTrace(await api<Trace>(`/api/fnb/recall-trace?batchId=${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="stack">
      <PageHeader title="Recall trace" subtitle="One step back to the supplier, one step forward to every business customer supplied.">
        {trace && <>
          <button className="btn ghost no-print" onClick={() => setTrace(undefined)}>New search</button>
          <button className="btn primary no-print" onClick={() => window.print()}>Print</button>
        </>}
      </PageHeader>
      <ErrorBanner message={error} />
      {!trace && (
        <Card title="Find the batch" pad>
          <Field label="Batch code, SKU or product name" hint="Type at least two characters">
            <input type="search" autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. L2610 or YOG-500" style={{ maxWidth: 420 }} />
          </Field>
          {batches && (
            <div style={{ marginTop: 16 }}>
              <DataTable rows={batches} empty={<Empty title="No matching batches" />} columns={[
                { key: "c", label: "Batch", render: (b) => <button className="btn small" onClick={() => open(b.id)}>Trace {b.code}</button> },
                { key: "p", label: "Product", render: (b) => <>{b.sku} <span className="muted">· {b.product_name}</span></> },
                { key: "d", label: "Date mark", render: (b) => <DateMark expiry={b.expiry} type={b.date_type} /> },
                { key: "s", label: "Status", render: (b) => <ExpiryPill status={b.status} /> },
                { key: "q", label: "On hand", num: true, render: (b) => qty(b.on_hand) },
              ]} />
            </div>
          )}
        </Card>
      )}
      {trace && (
        <>
          <Card pad>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
              <div>
                <div className="muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>Batch</div>
                <div style={{ fontSize: 22, fontWeight: 500 }}><span className="batch-code" style={{ fontSize: 22 }}>{trace.batch.code}</span> · {trace.batch.sku} {trace.batch.product_name}</div>
                <div style={{ marginTop: 4 }}><DateMark expiry={trace.batch.expiry} type={trace.batch.date_type} /> · <ExpiryPill status={trace.batch.status} /></div>
              </div>
              <div className="muted" style={{ fontSize: 13, textAlign: "right" }}>
                Generated {dateTime(trace.generatedAt ?? new Date().toISOString())}<br />
                <Link className="no-print" href={`/fnb/batches/${trace.batch.id}`}>Open batch and movements</Link>
              </div>
            </div>
          </Card>
          <TraceView trace={trace} />
        </>
      )}
    </div>
  );
}
