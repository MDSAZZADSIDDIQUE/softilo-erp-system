"use client";

import Link from "next/link";
import { Card, DataTable, Empty, ErrorBanner, PageHeader, Stat } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money, qty } from "@/lib/format";
import { MfgStatus } from "@mfg/components/mfg";

interface Wo { id: string; number: string; sku: string; name: string; status: string; quantity: string; completed_qty: string; due_date: string | null; wip: string }
interface Shortage { productId: string; sku: string; name: string; shortage: string; action: "make" | "buy" | null; uom: string }
interface Integrity { wip: { ledger: string; reconciled: boolean }; allReconciled: boolean }

export default function ProductionOverviewPage() {
  const orders = useApi<Wo[]>("/api/mfg/works-orders?status=open");
  const mrp = useApi<Shortage[]>("/api/mfg/mrp");
  const integrity = useApi<Integrity>("/api/mfg/integrity");
  const short = mrp.data?.filter((r) => r.action);
  const overdue = orders.data?.filter((o) => o.due_date && o.due_date < new Date().toISOString().slice(0, 10)).length ?? 0;
  return (
    <div className="stack">
      <PageHeader title="Production" subtitle="Works orders in progress, value in WIP and what is short.">
        <Link className="btn primary" href="/manufacturing/works-orders/new">New works order</Link>
      </PageHeader>
      <ErrorBanner message={orders.error ?? mrp.error ?? integrity.error} />
      <div className="grid-4">
        <Stat label="Open works orders" value={orders.data?.length ?? "–"} href="/manufacturing/works-orders"
          sub={overdue ? `${overdue} past due date` : "None past due"} alert={overdue > 0} />
        <Stat label="Work in progress" value={money(integrity.data?.wip.ledger)}
          sub={integrity.data ? (integrity.data.allReconciled ? "Agrees with works orders" : "Does not agree with works orders") : undefined}
          alert={integrity.data ? !integrity.data.allReconciled : false} />
        <Stat label="Items to buy" value={short?.filter((r) => r.action === "buy").length ?? "–"} href="/manufacturing/mrp"
          sub="Short for open works orders" alert={(short?.some((r) => r.action === "buy")) ?? false} />
        <Stat label="Sub-assemblies to make" value={short?.filter((r) => r.action === "make").length ?? "–"} href="/manufacturing/mrp"
          sub="Not covered by stock or orders" />
      </div>
      <div className="grid-main">
        <Card title="Open works orders" actions={<Link className="btn small" href="/manufacturing/works-orders">All orders</Link>}>
          <DataTable rows={orders.data} href={(o) => `/manufacturing/works-orders/${o.id}`}
            empty={<Empty title="No open works orders"><Link href="/manufacturing/works-orders/new">Plan one</Link></Empty>}
            columns={[
              { key: "n", label: "Order", render: (o) => <Link href={`/manufacturing/works-orders/${o.id}`}>{o.number}</Link> },
              { key: "p", label: "Product", render: (o) => <>{o.sku} <span className="muted">{o.name}</span></> },
              { key: "s", label: "Status", render: (o) => <MfgStatus value={o.status} /> },
              { key: "q", label: "Made", num: true, render: (o) => `${qty(o.completed_qty)} / ${qty(o.quantity)}` },
              { key: "d", label: "Due", render: (o) => date(o.due_date) },
              { key: "w", label: "WIP", num: true, render: (o) => money(o.wip) },
            ]} />
        </Card>
        <Card title="Shortages" actions={<Link className="btn small" href="/manufacturing/mrp">Full report</Link>}>
          <DataTable rows={short} empty={<Empty title="Nothing is short">Stock and open orders cover every works order.</Empty>}
            columns={[
              { key: "p", label: "Item", render: (r) => r.sku },
              { key: "s", label: "Short", num: true, render: (r) => `${qty(r.shortage)} ${r.uom}` },
              { key: "a", label: "Action", render: (r) => <MfgStatus value={r.action} /> },
            ]} />
        </Card>
      </div>
    </div>
  );
}
