"use client";

import Link from "next/link";
import { Card, DataTable, Empty, ErrorBanner, PageHeader, paymentStatus, Status } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money } from "@/lib/format";

interface Bill { id: string; number: string; kind: string; supplier_name: string; supplier_ref: string; date: string; due_date: string; currency: string; total: string; amount_paid: string; outstanding: string }

export default function BillsPage() {
  const { data, error } = useApi<Bill[]>("/api/supplier-bills");
  const todayIso = new Date().toISOString().slice(0, 10);
  return (
    <div className="stack">
      <PageHeader title="Supplier bills" subtitle="Bills for goods received, freight, duty and overheads.">
        <Link className="btn" href="/bills/new?kind=credit">New supplier credit</Link>
        <Link className="btn primary" href="/bills/new">New bill</Link>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card>
        <DataTable rows={data} href={(b) => `/bills/${b.id}`}
          empty={<Empty title="No supplier bills yet"><Link href="/bills/new">Enter a bill</Link></Empty>}
          columns={[
            { key: "n", label: "Number", render: (b) => <Link href={`/bills/${b.id}`}>{b.number}</Link> },
            { key: "s", label: "Supplier", render: (b) => b.supplier_name },
            { key: "r", label: "Their ref", render: (b) => b.supplier_ref },
            { key: "d", label: "Date", render: (b) => date(b.date) },
            { key: "due", label: "Due", render: (b) => date(b.due_date) },
            { key: "st", label: "Status", render: (b) => <Status value={b.kind === "credit" ? "credit" : paymentStatus({ ...b, overdue: b.due_date < todayIso })} /> },
            { key: "t", label: "Total", num: true, render: (b) => money(b.kind === "credit" ? `-${b.total}` : b.total, b.currency) },
            { key: "o", label: "Outstanding", num: true, render: (b) => money(b.outstanding, b.currency) },
          ]} />
      </Card>
    </div>
  );
}
