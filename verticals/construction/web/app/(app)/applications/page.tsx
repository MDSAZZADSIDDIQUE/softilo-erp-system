"use client";

import Link from "next/link";
import { stageLabel } from "@/components/cons";
import { Card, DataTable, Empty, ErrorBanner, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money } from "@/lib/format";

interface Application { id: string; reference: string; stage: string; date: string; project_code: string; customer_name: string; gross_to_date: string; retention_to_date: string; amount_due: string; vat_code: string; total: string; final_date: string; pay_less_by: string; outstanding: string }

export default function ApplicationsPage() {
  const { data, error } = useApi<Application[]>("/api/construction/applications");
  return (
    <div className="stack">
      <PageHeader title="Applications for payment" subtitle="Valuations to customers, with retention held back. New applications are made from a project." />
      <ErrorBanner message={error} />
      <Card>
        <DataTable rows={data} href={(a) => `/applications/${a.id}`}
          empty={<Empty title="No applications yet"><Link href="/projects">Open a project to apply for payment</Link></Empty>}
          columns={[
            { key: "r", label: "Reference", render: (a) => <Link href={`/applications/${a.id}`}>{a.reference}</Link> },
            { key: "c", label: "Customer", render: (a) => a.customer_name },
            { key: "s", label: "Stage", render: (a) => stageLabel(a.stage) },
            { key: "d", label: "Date", render: (a) => date(a.date) },
            { key: "g", label: "Gross to date", num: true, render: (a) => money(a.gross_to_date) },
            { key: "ret", label: "Retention held", num: true, render: (a) => money(a.retention_to_date) },
            { key: "t", label: "Invoice total", num: true, render: (a) => money(a.total) },
            { key: "f", label: "Final date", render: (a) => <span className="deadline">{date(a.final_date)}<small>Pay-less by {date(a.pay_less_by)}</small></span> },
            { key: "o", label: "Outstanding", num: true, render: (a) => money(a.outstanding) },
          ]} />
      </Card>
    </div>
  );
}
