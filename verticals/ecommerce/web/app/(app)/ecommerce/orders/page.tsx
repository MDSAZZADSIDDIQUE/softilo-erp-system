"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Card, DataTable, Empty, ErrorBanner, PageHeader, paymentStatus, Status } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money } from "@/lib/format";
import { margin } from "@ecom/components/ecom";

interface Order { id: string; order_number: string; date: string; customer_name: string; channel_name: string; invoice_number: string; total: string; amount_paid: string; net: string; cost: string; refunded: string }

export default function OrdersPage() {
  const channelId = useSearchParams().get("channelId");
  const { data, error } = useApi<Order[]>(`/api/ecommerce/orders${channelId ? `?channelId=${channelId}` : ""}`);
  return (
    <div className="stack">
      <PageHeader title="Channel orders" subtitle="Each order is a sales invoice to its channel, with stock issued at cost" />
      <ErrorBanner message={error} />
      <Card>
        <DataTable rows={data} href={(o) => `/ecommerce/orders/${o.id}`}
          empty={<Empty title="No orders yet"><Link href="/ecommerce">Import orders from a channel</Link></Empty>}
          columns={[
            { key: "n", label: "Order", render: (o) => <Link href={`/ecommerce/orders/${o.id}`}>{o.order_number}</Link> },
            { key: "d", label: "Date", render: (o) => date(o.date) },
            { key: "c", label: "Customer", render: (o) => o.customer_name },
            { key: "ch", label: "Channel", render: (o) => o.channel_name },
            { key: "i", label: "Invoice", render: (o) => o.invoice_number },
            { key: "s", label: "Payout", render: (o) => <Status value={paymentStatus({ total: o.total, amount_paid: o.amount_paid })} /> },
            { key: "t", label: "Total", num: true, render: (o) => money(o.total) },
            { key: "m", label: "Margin", num: true, render: (o) => { const m = margin(o.net, o.cost); return <>{money(m.value)} <span className="faint">{m.pct}</span></>; } },
            { key: "r", label: "Refunded", num: true, render: (o) => Number(o.refunded) ? money(o.refunded) : "–" },
          ]} />
      </Card>
    </div>
  );
}
