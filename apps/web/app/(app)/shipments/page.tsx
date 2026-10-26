"use client";

import Link from "next/link";
import { Card, DataTable, Empty, ErrorBanner, PageHeader, Status } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money } from "@/lib/format";

interface Shipment { id: string; number: string; reference: string | null; mrn: string | null; date: string; status: string; lines: string; goods_value: string; costs: string }

export default function ShipmentsPage() {
  const { data, error } = useApi<Shipment[]>("/api/shipments");
  return (
    <div className="stack">
      <PageHeader title="Shipments & landed cost" subtitle="Group received goods by container, add freight, duty and fees, and land them onto stock.">
        <Link className="btn primary" href="/shipments/new">New shipment</Link>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card>
        <DataTable rows={data} href={(s) => `/shipments/${s.id}`}
          empty={<Empty title="No shipments yet">Receive goods on a purchase order, then <Link href="/shipments/new">group them into a shipment</Link>.</Empty>}
          columns={[
            { key: "n", label: "Shipment", render: (s) => <Link href={`/shipments/${s.id}`}>{s.number}</Link> },
            { key: "r", label: "Container / B/L", render: (s) => s.reference ?? <span className="faint">–</span> },
            { key: "m", label: "MRN", render: (s) => s.mrn ? <span className="mono">{s.mrn}</span> : <span className="faint">–</span> },
            { key: "d", label: "Arrived", render: (s) => date(s.date) },
            { key: "st", label: "Status", render: (s) => <Status value={s.status} /> },
            { key: "g", label: "Goods", num: true, render: (s) => money(s.goods_value) },
            { key: "c", label: "Landed costs", num: true, render: (s) => money(s.costs) },
            { key: "u", label: "Uplift", num: true, render: (s) => Number(s.goods_value) ? `${((Number(s.costs) / Number(s.goods_value)) * 100).toFixed(1)}%` : "–" },
          ]} />
      </Card>
    </div>
  );
}
