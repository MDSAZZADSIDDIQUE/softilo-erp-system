"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, DataTable, Empty, ErrorBanner, PageHeader, RecStatus, Tabs } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money } from "@/lib/format";

interface Timesheet {
  id: string; number: string; week_ending: string; status: string; hours: string; charge: string; cost: string; margin: string;
  worker_name: string; client_name: string; job_title: string; placement_number: string; invoice_number: string | null;
}

const TABS = [
  { id: "submitted", label: "Awaiting approval" }, { id: "draft", label: "Drafts" }, { id: "rejected", label: "Rejected" },
  { id: "approved", label: "Approved" }, { id: "invoiced", label: "Invoiced" }, { id: "all", label: "All" },
];

export default function TimesheetsPage() {
  const router = useRouter();
  const tab = useSearchParams().get("status") ?? "submitted";
  const { data, error } = useApi<Timesheet[]>(tab === "all" ? "/api/rec/timesheets" : `/api/rec/timesheets?status=${tab}`);
  return (
    <div className="stack">
      <PageHeader title="Timesheets" subtitle="Weekly hours: submitted, approved by the client, then invoiced.">
        <Link className="btn primary" href="/timesheets/new">Enter timesheet</Link>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card>
        <div className="card-pad" style={{ paddingBottom: 0 }}>
          <Tabs tabs={TABS} active={tab} onChange={(id) => router.replace(`/timesheets?status=${id}`)} />
        </div>
        <DataTable rows={data} href={(t) => `/timesheets/${t.id}`}
          empty={<Empty title="Nothing here" />}
          columns={[
            { key: "n", label: "Number", render: (t) => <Link href={`/timesheets/${t.id}`}>{t.number}</Link> },
            { key: "w", label: "Week ending", render: (t) => date(t.week_ending) },
            { key: "who", label: "Worker", render: (t) => <>{t.worker_name}<div className="faint">{t.placement_number} · {t.job_title}</div></> },
            { key: "c", label: "Client", render: (t) => t.client_name },
            { key: "s", label: "Status", render: (t) => <RecStatus value={t.status} /> },
            { key: "h", label: "Hours", num: true, render: (t) => Number(t.hours).toFixed(2) },
            { key: "ch", label: "Charge", num: true, render: (t) => money(t.charge) },
            { key: "m", label: "Margin", num: true, render: (t) => money(t.margin) },
            { key: "i", label: "Invoice", render: (t) => t.invoice_number ?? "–" },
          ]} />
      </Card>
    </div>
  );
}
