"use client";

import Link from "next/link";
import { Card, DataTable, ErrorBanner, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money } from "@/lib/format";

const SOURCES: Record<string, string> = {
  manual: "Manual journal", goods_receipt: "Goods received", supplier_bill: "Supplier bill", sales_invoice: "Sales",
  payment: "Payment", shipment: "Landed cost", stock_adjustment: "Stock adjustment", bank_transaction: "Bank",
  pva: "Postponed VAT", vat_return: "VAT return",
};

interface Journal { id: string; number: string; date: string; memo: string; source_type: string; total: string; created_by_name: string | null; reverses_id: string | null }

export default function JournalsPage() {
  const { data, error } = useApi<Journal[]>("/api/journals?limit=500");
  return (
    <div className="stack">
      <PageHeader title="Journals" subtitle="Every posting in the ledger. Entries are never edited; corrections are new entries.">
        <Link className="btn primary" href="/journals/new">New manual journal</Link>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card>
        <DataTable rows={data} href={(j) => `/journals/${j.id}`} columns={[
          { key: "n", label: "Number", render: (j) => <Link href={`/journals/${j.id}`}>{j.number}</Link> },
          { key: "d", label: "Date", render: (j) => date(j.date) },
          { key: "s", label: "Source", render: (j) => <span className="pill quiet">{SOURCES[j.source_type] ?? j.source_type}</span> },
          { key: "m", label: "Description", render: (j) => j.memo },
          { key: "u", label: "By", render: (j) => j.created_by_name ?? <span className="faint">System</span> },
          { key: "t", label: "Amount", num: true, render: (j) => money(j.total) },
        ]} />
      </Card>
    </div>
  );
}
