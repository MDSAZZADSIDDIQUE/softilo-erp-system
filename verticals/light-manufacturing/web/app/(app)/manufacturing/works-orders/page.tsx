"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, PageHeader, Tabs } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money, qty } from "@/lib/format";
import { MfgStatus } from "@mfg/components/mfg";

interface Wo {
  id: string; number: string; sku: string; name: string; status: string; quantity: string;
  completed_qty: string; scrapped_qty: string; due_date: string | null; warehouse: string; wip: string;
}

export default function WorksOrdersPage() {
  const [tab, setTab] = useState("open");
  const { data, error } = useApi<Wo[]>(`/api/mfg/works-orders${tab === "all" ? "" : `?status=${tab}`}`);
  return (
    <div className="stack">
      <PageHeader title="Works orders" subtitle="Plan, release, issue materials, book time and complete into stock.">
        <Link className="btn primary" href="/manufacturing/works-orders/new">New works order</Link>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card>
        <div className="card-pad" style={{ paddingBottom: 0 }}>
          <Tabs active={tab} onChange={setTab} tabs={[
            { id: "open", label: "Open" }, { id: "completed", label: "Completed" }, { id: "all", label: "All" },
          ]} />
        </div>
        <DataTable rows={data} href={(o) => `/manufacturing/works-orders/${o.id}`}
          empty={<Empty title="No works orders here"><Link href="/manufacturing/works-orders/new">Plan a works order</Link></Empty>}
          columns={[
            { key: "n", label: "Order", render: (o) => <Link href={`/manufacturing/works-orders/${o.id}`}>{o.number}</Link> },
            { key: "p", label: "Product", render: (o) => <>{o.sku} <span className="muted">{o.name}</span></> },
            { key: "s", label: "Status", render: (o) => <MfgStatus value={o.status} /> },
            { key: "q", label: "Quantity", num: true, render: (o) => qty(o.quantity) },
            { key: "c", label: "Made", num: true, render: (o) => qty(o.completed_qty) },
            { key: "x", label: "Scrapped", num: true, render: (o) => qty(o.scrapped_qty) },
            { key: "d", label: "Due", render: (o) => date(o.due_date) },
            { key: "w", label: "WIP", num: true, render: (o) => money(o.wip) },
          ]} />
      </Card>
    </div>
  );
}
