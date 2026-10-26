"use client";

import Link from "next/link";
import { CisPill } from "@/components/cons";
import { Card, DataTable, Empty, ErrorBanner, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money } from "@/lib/format";

interface Bill { id: string; number: string; supplier_ref: string; date: string; supplier_name: string; project_code: string; cis_status: string | null; gross: string; materials: string; deduction: string; total: string; outstanding: string }

export default function BillsPage() {
  const { data, error } = useApi<Bill[]>("/api/construction/bills");
  return (
    <div className="stack">
      <PageHeader title="Job bills" subtitle="Subcontractor and merchant bills charged to projects, with CIS deducted on labour.">
        <Link className="btn primary" href="/bills/new">Enter job bill</Link>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card>
        <DataTable rows={data}
          empty={<Empty title="No job bills yet"><Link href="/bills/new">Enter a bill</Link></Empty>}
          columns={[
            { key: "n", label: "Number", render: (b) => b.number },
            { key: "p", label: "Project", render: (b) => b.project_code },
            { key: "s", label: "Supplier", render: (b) => b.supplier_name },
            { key: "r", label: "Their ref", render: (b) => b.supplier_ref },
            { key: "d", label: "Date", render: (b) => date(b.date) },
            { key: "c", label: "CIS", render: (b) => <CisPill status={b.cis_status} /> },
            { key: "g", label: "Net of VAT", num: true, render: (b) => money(b.gross) },
            { key: "x", label: "Deducted", num: true, render: (b) => money(b.deduction) },
            { key: "t", label: "Payable", num: true, render: (b) => money(b.total) },
            { key: "o", label: "Outstanding", num: true, render: (b) => money(b.outstanding) },
          ]} />
      </Card>
    </div>
  );
}
