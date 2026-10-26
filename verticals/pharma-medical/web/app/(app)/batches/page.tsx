"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Card, DataTable, ErrorBanner, PageHeader, Tabs } from "@/components/ui";
import { BatchStatus, ExpiryBand } from "@/components/pharma";
import { useApi } from "@/lib/api";
import { date, qty } from "@/lib/format";

interface Batch { id: string; sku: string; product_name: string; batch_number: string; expiry: string; band: string; status: string;
  on_hand: string; received_qty: string; supplier_name: string; warehouse_name: string; receipt_number: string }

const TABS = [
  { id: "", label: "All" }, { id: "quarantine", label: "Quarantine" }, { id: "released", label: "Released" },
  { id: "rejected", label: "Rejected" }, { id: "recalled", label: "Recalled" },
];

export default function BatchesPage() {
  const router = useRouter();
  const status = useSearchParams().get("status") ?? "";
  const [search, setSearch] = useState("");
  const params = new URLSearchParams({ ...(status && { status }), ...(search && { batchNumber: search }) });
  const { data, error } = useApi<Batch[]>(`/api/pharma/batches?${params}`);

  return (
    <div className="stack">
      <PageHeader title="Batches & release" subtitle="Every batch received, its expiry and its GDP status, earliest expiry first" />
      <ErrorBanner message={error} />
      <Card title={<Tabs tabs={TABS} active={status} onChange={(s) => router.push(s ? `/batches?status=${s}` : "/batches")} />}
        actions={<input type="search" placeholder="Batch number" aria-label="Search batch number" value={search} onChange={(e) => setSearch(e.target.value)} />}>
        <DataTable rows={data} href={(b) => `/batches/${b.id}`}
          empty={<div className="empty"><strong>No batches</strong>Receive stock through Goods in to create batches.</div>}
          columns={[
            { key: "sku", label: "Product", render: (b) => <><strong>{b.sku}</strong> <span className="muted">{b.product_name}</span></> },
            { key: "batch", label: "Batch", render: (b) => <span className="mono">{b.batch_number}</span> },
            { key: "expiry", label: "Expiry", render: (b) => <>{date(b.expiry)} <ExpiryBand band={b.band} /></> },
            { key: "grn", label: "Receipt", render: (b) => <>{b.receipt_number} <span className="muted">{b.supplier_name}</span></> },
            { key: "wh", label: "Warehouse", render: (b) => b.warehouse_name },
            { key: "recv", label: "Received", num: true, render: (b) => qty(b.received_qty) },
            { key: "on", label: "On hand", num: true, render: (b) => qty(b.on_hand) },
            { key: "status", label: "Status", render: (b) => <BatchStatus value={b.status} /> },
          ]} />
      </Card>
    </div>
  );
}
