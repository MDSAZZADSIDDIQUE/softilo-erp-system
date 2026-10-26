"use client";

import Link from "next/link";
import { Card, DataTable, Empty, ErrorBanner, PageHeader, RecStatus } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date } from "@/lib/format";

interface Awr {
  id: string; number: string; worker_name: string; client_name: string; job_title: string; awr_start: string; status: string;
  weeksCompleted: number; weeksRemaining: number; qualifiedOn: string | null; projectedQualifyingDate: string | null; soon: boolean;
}

export default function AwrPage() {
  const { data, error } = useApi<Awr[]>("/api/rec/awr");
  return (
    <div className="stack">
      <PageHeader title="AWR tracker"
        subtitle="Agency Workers Regulations: after 12 weeks in the same role with the same hirer, workers get the same basic pay and conditions as direct recruits." />
      <ErrorBanner message={error} />
      <Card>
        <DataTable rows={data} href={(a) => `/placements/${a.id}`}
          empty={<Empty title="No active placements are covered by the AWR" />}
          columns={[
            { key: "n", label: "Placement", render: (a) => <Link href={`/placements/${a.id}`}>{a.number}</Link> },
            { key: "w", label: "Worker", render: (a) => a.worker_name },
            { key: "c", label: "Hirer and role", render: (a) => <>{a.client_name}<div className="faint">{a.job_title}</div></> },
            { key: "s", label: "Clock started", render: (a) => date(a.awr_start) },
            { key: "p", label: "Progress", render: (a) => (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div className={`progress${a.qualifiedOn ? " done" : ""}`}><i style={{ width: `${Math.min(100, (a.weeksCompleted / 12) * 100)}%` }} /></div>
                <span className="mono">{Math.min(a.weeksCompleted, 12)}/12</span>
              </div>
            ) },
            { key: "q", label: "Equal treatment from", render: (a) => (a.qualifiedOn ? date(a.qualifiedOn) : a.projectedQualifyingDate ? <span className="faint">{date(a.projectedQualifyingDate)} (projected)</span> : "–") },
            { key: "st", label: "Status", render: (a) => (a.soon ? <span className="pill signal">Qualifies soon</span> : <RecStatus value={a.status} />) },
          ]} />
      </Card>
    </div>
  );
}
