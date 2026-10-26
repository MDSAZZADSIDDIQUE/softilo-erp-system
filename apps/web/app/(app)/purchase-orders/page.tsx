"use client";

import Link from "next/link";
import { Card, DataTable, Empty, ErrorBanner, PageHeader, Status } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money } from "@/lib/format";

interface Po { id: string; number: string; supplier_name: string; date: string; expected_date: string | null; currency: string; total: string; status: string }

export default function PurchaseOrdersPage() {
  const { data, error } = useApi<Po[]>("/api/purchase-orders");
  return (
    <div className="stack">
      <PageHeader title="Purchase orders" subtitle="Order, approve, then receive goods into stock.">
        <Link className="btn primary" href="/purchase-orders/new">New purchase order</Link>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card>
        <DataTable rows={data} href={(p) => `/purchase-orders/${p.id}`}
          empty={<Empty title="No purchase orders yet"><Link href="/purchase-orders/new">Raise your first order</Link></Empty>}
          columns={[
            { key: "n", label: "Number", render: (p) => <Link href={`/purchase-orders/${p.id}`}>{p.number}</Link> },
            { key: "s", label: "Supplier", render: (p) => p.supplier_name },
            { key: "d", label: "Ordered", render: (p) => date(p.date) },
            { key: "e", label: "Expected", render: (p) => date(p.expected_date) },
            { key: "st", label: "Status", render: (p) => <Status value={p.status} /> },
            { key: "t", label: "Total", num: true, render: (p) => money(p.total, p.currency) },
          ]} />
      </Card>
    </div>
  );
}
