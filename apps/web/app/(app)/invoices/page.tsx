"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, PageHeader, paymentStatus, Status, Tabs } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money } from "@/lib/format";

interface Invoice { id: string; number: string; kind: string; customer_name: string; date: string; due_date: string; currency: string; total: string; amount_paid: string; outstanding: string; overdue: boolean }

export default function InvoicesPage() {
  const { data, error } = useApi<Invoice[]>("/api/sales-invoices");
  const [tab, setTab] = useState("all");
  const rows = data?.filter((i) => tab === "all" || (tab === "unpaid" && i.kind === "invoice" && Number(i.outstanding) > 0) || (tab === "overdue" && i.overdue) || (tab === "credits" && i.kind === "credit"));
  const owed = data?.filter((i) => i.kind === "invoice").reduce((s, i) => s + Number(i.outstanding), 0) ?? 0;
  return (
    <div className="stack">
      <PageHeader title="Invoices & credit notes" subtitle={data ? `${money(owed)} outstanding` : undefined}>
        <Link className="btn" href="/invoices/new?kind=credit">New credit note</Link>
        <Link className="btn primary" href="/invoices/new">New invoice</Link>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card>
        <div className="card-pad" style={{ paddingBottom: 0 }}>
          <Tabs active={tab} onChange={setTab} tabs={[
            { id: "all", label: "All" }, { id: "unpaid", label: "Unpaid" }, { id: "overdue", label: "Overdue" }, { id: "credits", label: "Credit notes" },
          ]} />
        </div>
        <DataTable rows={rows} href={(i) => `/invoices/${i.id}`}
          empty={<Empty title="Nothing to show"><Link href="/invoices/new">Raise an invoice</Link></Empty>}
          columns={[
            { key: "n", label: "Number", render: (i) => <Link href={`/invoices/${i.id}`}>{i.number}</Link> },
            { key: "c", label: "Customer", render: (i) => i.customer_name },
            { key: "d", label: "Date", render: (i) => date(i.date) },
            { key: "due", label: "Due", render: (i) => i.kind === "credit" ? "–" : date(i.due_date) },
            { key: "st", label: "Status", render: (i) => <Status value={paymentStatus(i)} /> },
            { key: "t", label: "Total", num: true, render: (i) => money(i.kind === "credit" ? `-${i.total}` : i.total, i.currency) },
            { key: "o", label: "Outstanding", num: true, render: (i) => money(i.kind === "credit" ? `-${i.outstanding}` : i.outstanding, i.currency) },
          ]} />
      </Card>
    </div>
  );
}
