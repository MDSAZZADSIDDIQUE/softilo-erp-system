"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, PageHeader, Tabs } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money, qty } from "@/lib/format";

interface Return {
  id: string; number: string; received_date: string; refund_due_by: string; refund: string; deduction: string; reason: string | null;
  order_id: string; order_number: string; customer_name: string; channel_name: string; credit_note_number: string;
  refunded: boolean; overdue: boolean; restocked: string; written_off: string;
}

export default function ReturnsPage() {
  const { data, error } = useApi<Return[]>("/api/ecommerce/returns");
  const [tab, setTab] = useState("all");
  const rows = data?.filter((r) => tab === "all" || (tab === "open" && !r.refunded) || (tab === "overdue" && r.overdue));
  return (
    <div className="stack">
      <PageHeader title="Returns" subtitle="Refunds are due within 14 days of the goods coming back (Consumer Contracts Regulations 2013)" />
      <ErrorBanner message={error} />
      <Card>
        <div className="card-pad" style={{ paddingBottom: 0 }}>
          <Tabs active={tab} onChange={setTab} tabs={[{ id: "all", label: "All" }, { id: "open", label: "Awaiting refund" }, { id: "overdue", label: "Overdue" }]} />
        </div>
        <DataTable rows={rows} href={(r) => `/ecommerce/orders/${r.order_id}`}
          empty={<Empty title="No returns">Record a return from its order.</Empty>}
          columns={[
            { key: "n", label: "Return", render: (r) => r.number },
            { key: "o", label: "Order", render: (r) => <Link href={`/ecommerce/orders/${r.order_id}`}>{r.order_number}</Link> },
            { key: "c", label: "Customer", render: (r) => r.customer_name },
            { key: "d", label: "Received", render: (r) => date(r.received_date) },
            { key: "due", label: "Refund due by", render: (r) => date(r.refund_due_by) },
            { key: "s", label: "Status", render: (r) => <span className={`pill ${r.refunded ? "quiet ok" : r.overdue ? "signal" : ""}`}>{r.refunded ? "Refunded" : r.overdue ? "Overdue" : "Awaiting payout"}</span> },
            { key: "st", label: "Restocked", num: true, render: (r) => qty(r.restocked) },
            { key: "w", label: "Written off", num: true, render: (r) => qty(r.written_off) },
            { key: "a", label: "Refund", num: true, render: (r) => money(r.refund) },
          ]} />
      </Card>
    </div>
  );
}
