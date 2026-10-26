"use client";

import Link from "next/link";
import { Card, DataTable, Empty, ErrorBanner, PageHeader, RecStatus, Stat } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money } from "@/lib/format";

interface Dashboard {
  active_placements: number; awaiting_approval: number; drafts: number;
  to_invoice: string; sales_month: string; margin_month: string; debtors: string;
}
interface Awr { id: string; number: string; worker_name: string; client_name: string; status: string; weeksCompleted: number; projectedQualifyingDate: string | null; soon: boolean }

export default function DashboardPage() {
  const { data, error } = useApi<Dashboard>("/api/rec/dashboard");
  const { data: awr } = useApi<Awr[]>("/api/rec/awr");
  const { data: integrity } = useApi<{ reconciled: boolean }>("/api/rec/integrity");
  const soon = awr?.filter((a) => a.soon);
  const marginPct = data && Number(data.sales_month) ? (Number(data.margin_month) / Number(data.sales_month)) * 100 : null;
  return (
    <div className="stack">
      <PageHeader title="Dashboard" subtitle="Placements, timesheets and billing at a glance.">
        <Link className="btn" href="/placements/new">New placement</Link>
        <Link className="btn primary" href="/timesheets/new">Enter timesheet</Link>
      </PageHeader>
      <ErrorBanner message={error} />
      {integrity && !integrity.reconciled && (
        <div className="banner error" role="alert">Worker pay accruals do not match approved timesheets. Check the integrity report.</div>
      )}
      <div className="grid-4">
        <Stat label="Active placements" value={data?.active_placements ?? "–"} href="/placements" />
        <Stat label="Awaiting client approval" value={data?.awaiting_approval ?? "–"} sub={data ? `${data.drafts} drafts or rejected` : undefined}
          alert={Boolean(data?.awaiting_approval)} href="/timesheets?status=submitted" />
        <Stat label="Approved, not invoiced" value={money(data?.to_invoice)} alert={Number(data?.to_invoice ?? 0) > 0} href="/billing" />
        <Stat label="Gross margin this month" value={money(data?.margin_month)}
          sub={marginPct === null ? "No approved hours yet" : `${marginPct.toFixed(1)}% of ${money(data?.sales_month)} sales`} href="/margin" />
      </div>
      <div className="grid-main">
        <Card title="AWR: qualifying in the next 4 weeks" actions={<Link href="/awr">All placements</Link>}>
          <DataTable rows={soon} href={(a) => `/placements/${a.id}`}
            empty={<Empty title="No one is about to qualify">Agency workers gain equal treatment after 12 weeks in the same role with the same hirer.</Empty>}
            columns={[
              { key: "w", label: "Worker", render: (a) => a.worker_name },
              { key: "c", label: "Client", render: (a) => a.client_name },
              { key: "n", label: "Weeks", num: true, render: (a) => `${a.weeksCompleted} / 12` },
              { key: "d", label: "Qualifies", render: (a) => date(a.projectedQualifyingDate) },
              { key: "s", label: "Status", render: (a) => <RecStatus value={a.status} /> },
            ]} />
        </Card>
        <Card title="Money owed by clients" pad>
          <div className="stat" style={{ padding: 0 }}>
            <div className="value">{money(data?.debtors)}</div>
            <div className="sub"><Link href="/invoices">See invoices</Link></div>
          </div>
        </Card>
      </div>
    </div>
  );
}
