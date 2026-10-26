"use client";

import Link from "next/link";
import { Card, DataTable, ErrorBanner, PageHeader, Stat } from "@/components/ui";
import { BatchStatus, ExpiryBand, useIsRp } from "@/components/pharma";
import { useApi } from "@/lib/api";
import { date, qty } from "@/lib/format";

interface Dashboard { quarantine: string; recalled: string; expiring: string; expired: string; licencesNeedingAttention: number }
interface Batch { id: string; sku: string; product_name: string; batch_number: string; expiry: string; band: string; status: string;
  on_hand: string; supplier_name: string; received_on: string }
interface Integrity { allReconciled: boolean; lines: { sku: string; warehouse: string; batches: string; stock: string; reconciled: boolean }[] }

export default function QualityPage() {
  const { data: d, error } = useApi<Dashboard>("/api/pharma/dashboard");
  const { data: queue } = useApi<Batch[]>("/api/pharma/batches?status=quarantine");
  const { data: integrity } = useApi<Integrity>("/api/pharma/integrity");
  const isRp = useIsRp();

  return (
    <div className="stack">
      <PageHeader title="GDP overview" subtitle="Batch release, expiry and customer licences under Good Distribution Practice">
        <Link className="btn" href="/goods-in">Goods in</Link>
        <Link className="btn primary" href="/dispatch">New dispatch</Link>
      </PageHeader>
      <ErrorBanner message={error} />
      {isRp === false && (
        <div className="notice">You are not a named Responsible Person, so you can view batches but not release, reject or recall them.</div>
      )}
      <div className="grid-4">
        <Stat label="Awaiting release" value={d?.quarantine ?? "–"} sub="batches in quarantine" alert={Number(d?.quarantine) > 0} href="/batches?status=quarantine" />
        <Stat label="Expiring in 90 days" value={d?.expiring ?? "–"} sub="released batches with stock" alert={Number(d?.expiring) > 0} href="/batches" />
        <Stat label="Expired on hand" value={d?.expired ?? "–"} sub="reject or return to supplier" alert={Number(d?.expired) > 0} href="/batches" />
        <Stat label="Licences to check" value={d?.licencesNeedingAttention ?? "–"} sub="expired, unverified or due" alert={Number(d?.licencesNeedingAttention) > 0} href="/licences" />
      </div>
      <Card title="Quarantine queue">
        <DataTable rows={queue} href={(b) => `/batches/${b.id}`}
          empty={<div className="empty"><strong>Nothing awaiting release</strong>Goods received with batches appear here until a Responsible Person decides.</div>}
          columns={[
            { key: "sku", label: "Product", render: (b) => <><strong>{b.sku}</strong> <span className="muted">{b.product_name}</span></> },
            { key: "batch", label: "Batch", render: (b) => <span className="mono">{b.batch_number}</span> },
            { key: "expiry", label: "Expiry", render: (b) => <>{date(b.expiry)} <ExpiryBand band={b.band} /></> },
            { key: "supplier", label: "Supplier", render: (b) => b.supplier_name },
            { key: "received", label: "Received", render: (b) => date(b.received_on) },
            { key: "qty", label: "Quantity", num: true, render: (b) => qty(b.on_hand) },
            { key: "status", label: "Status", render: (b) => <BatchStatus value={b.status} /> },
          ]} />
      </Card>
      <Card title="Batches vs. stock ledger" actions={integrity && (integrity.allReconciled
        ? <span className="pill quiet ok">Reconciled</span> : <span className="pill signal">Difference found</span>)}>
        <DataTable rows={integrity?.lines} empty={<div className="empty"><strong>No batch-tracked stock yet</strong></div>}
          columns={[
            { key: "sku", label: "Product", render: (l) => l.sku },
            { key: "wh", label: "Warehouse", render: (l) => l.warehouse },
            { key: "b", label: "In batches", num: true, render: (l) => qty(l.batches) },
            { key: "s", label: "In stock ledger", num: true, render: (l) => qty(l.stock) },
            { key: "r", label: "", render: (l) => l.reconciled ? <span className="pill quiet ok">Agrees</span> : <span className="pill signal">Differs</span> },
          ]} />
      </Card>
    </div>
  );
}
