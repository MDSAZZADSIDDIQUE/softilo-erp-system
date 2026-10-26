"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, PageHeader, Stat, Tabs } from "@core/components/ui";
import { useApi } from "@core/lib/api";
import { money, qty, today } from "@core/lib/format";
import { DateMark, DaysLeft, ExpiryPill, type BatchStatus } from "@/components/fnb";

interface Row {
  batch_id: string; code: string; expiry: string | null; date_type: string; sku: string; product_name: string; warehouse: string;
  quantity: string; supplier_name: string | null; daysLeft: number | null; status: BatchStatus; blocked: boolean; value: string;
}
interface Report {
  asAt: string; warnDays: number; rows: Row[];
  summary: Record<"expired" | "expiring" | "pastBestBefore" | "ok" | "noDate", { batches: number; value: string }>;
  integrity: { reconciled: boolean; mismatches: { sku: string; warehouse: string; stock: string; batches: string }[] };
}

const FILTERS: { id: string; label: string; match: (r: Row) => boolean }[] = [
  { id: "action", label: "Needs action", match: (r) => r.status !== "ok" && r.status !== "no_date" },
  { id: "all", label: "All stock", match: () => true },
];

export default function ExpiryReportPage() {
  const [asAt, setAsAt] = useState(today());
  const [warnDays, setWarnDays] = useState(7);
  const [filter, setFilter] = useState("action");
  const { data, error } = useApi<Report>(`/api/fnb/reports/expiry?asAt=${asAt}&warnDays=${warnDays}`);
  const rows = data?.rows.filter(FILTERS.find((f) => f.id === filter)!.match);
  const s = data?.summary;

  return (
    <div className="stack">
      <PageHeader title="Expiry report" subtitle="Stock by batch, soonest date first. Use-by stock past its date cannot be invoiced; write it off.">
        <button className="btn no-print" onClick={() => window.print()}>Print</button>
      </PageHeader>
      <ErrorBanner message={error} />
      {data && !data.integrity.reconciled && (
        <div className="banner error">
          Batches do not add up to stock for {data.integrity.mismatches.map((m) => `${m.sku} (${m.warehouse}: stock ${qty(m.stock)}, batches ${qty(m.batches)})`).join(", ")}.
          Stock was moved without a batch; correct it with a stock adjustment and batch receipt.
        </div>
      )}
      {s && (
        <div className="grid-4">
          <Stat label="Past use-by" value={s.expired.batches} sub={`${money(s.expired.value)} to write off`} alert={s.expired.batches > 0} />
          <Stat label={`Expiring in ${warnDays} days`} value={s.expiring.batches} sub={`${money(s.expiring.value)} at cost`} alert={s.expiring.batches > 0} />
          <Stat label="Past best-before" value={s.pastBestBefore.batches} sub={`${money(s.pastBestBefore.value)} · can still be sold`} />
          <Stat label="In date" value={s.ok.batches + s.noDate.batches} sub={money(Number(s.ok.value) + Number(s.noDate.value))} />
        </div>
      )}
      <Card title={
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <Tabs tabs={FILTERS} active={filter} onChange={setFilter} />
          <label className="muted" style={{ display: "flex", gap: 8, alignItems: "center" }}>As at <input type="date" value={asAt} onChange={(e) => setAsAt(e.target.value || today())} /></label>
          <label className="muted" style={{ display: "flex", gap: 8, alignItems: "center" }}>Warn within
            <select value={warnDays} onChange={(e) => setWarnDays(Number(e.target.value))}>
              {[3, 7, 14, 30].map((n) => <option key={n} value={n}>{n} days</option>)}
            </select>
          </label>
        </div>
      }>
        <DataTable rows={rows} href={(r) => `/fnb/batches/${r.batch_id}`}
          empty={<Empty title={filter === "action" ? "Nothing needs action" : "No batch-tracked stock"}>{filter === "action" ? "No batches are past or near their date." : <Link href="/fnb/products">Turn on batch tracking for food products</Link>}</Empty>}
          columns={[
            { key: "code", label: "Batch", render: (r) => <Link className="batch-code" href={`/fnb/batches/${r.batch_id}`}>{r.code}</Link> },
            { key: "p", label: "Product", render: (r) => <>{r.sku} <span className="muted">· {r.product_name}</span></> },
            { key: "w", label: "Warehouse", render: (r) => r.warehouse },
            { key: "d", label: "Date mark", render: (r) => <DateMark expiry={r.expiry} type={r.date_type} /> },
            { key: "left", label: "Life left", num: true, render: (r) => <DaysLeft days={r.daysLeft} /> },
            { key: "s", label: "Status", render: (r) => <ExpiryPill status={r.status} /> },
            { key: "q", label: "Quantity", num: true, render: (r) => qty(r.quantity) },
            { key: "v", label: "Value at cost", num: true, render: (r) => money(r.value) },
          ]} />
      </Card>
    </div>
  );
}
