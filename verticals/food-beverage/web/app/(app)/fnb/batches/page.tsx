"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, PageHeader } from "@core/components/ui";
import { useApi } from "@core/lib/api";
import { date, qty } from "@core/lib/format";
import { DateMark, DaysLeft, daysFromToday, ExpiryPill, type BatchStatus } from "@/components/fnb";

interface Batch {
  id: string; code: string; expiry: string | null; date_type: string; received_on: string; product_id: string; sku: string;
  product_name: string; supplier_name: string | null; on_hand: string; status: BatchStatus;
}

export default function BatchesPage() {
  const [search, setSearch] = useState("");
  const [inStock, setInStock] = useState(true);
  const params = new URLSearchParams();
  if (search.trim()) params.set("search", search.trim());
  if (inStock) params.set("inStock", "true");
  const { data, error } = useApi<Batch[]>(`/api/fnb/batches?${params}`);

  return (
    <div className="stack">
      <PageHeader title="Batches" subtitle="Every lot received, with its date mark and where it is now. Oldest date first.">
        <Link className="btn" href="/fnb/expiry">Expiry report</Link>
        <Link className="btn primary" href="/purchase-orders">Receive goods</Link>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card title={
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <input type="search" placeholder="Batch code, SKU or product…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 320 }} />
          <label className="checkbox"><input type="checkbox" checked={inStock} onChange={(e) => setInStock(e.target.checked)} /> In stock only</label>
        </div>
      }>
        <DataTable rows={data} href={(b) => `/fnb/batches/${b.id}`}
          empty={<Empty title="No batches yet">Batches are created when you receive batch-tracked products against a purchase order.</Empty>}
          columns={[
            { key: "code", label: "Batch", render: (b) => <Link className="batch-code" href={`/fnb/batches/${b.id}`}>{b.code}</Link> },
            { key: "product", label: "Product", render: (b) => <>{b.sku} <span className="muted">· {b.product_name}</span></> },
            { key: "date", label: "Date mark", render: (b) => <DateMark expiry={b.expiry} type={b.date_type} /> },
            { key: "left", label: "Life left", num: true, render: (b) => <DaysLeft days={daysFromToday(b.expiry)} /> },
            { key: "status", label: "Status", render: (b) => <ExpiryPill status={b.status} /> },
            { key: "supplier", label: "Supplier", render: (b) => b.supplier_name ?? <span className="faint">–</span> },
            { key: "received", label: "Received", render: (b) => date(b.received_on) },
            { key: "on", label: "On hand", num: true, render: (b) => qty(b.on_hand) },
          ]} />
      </Card>
    </div>
  );
}
