"use client";

import Link from "next/link";
import { Card, DataTable, Empty, ErrorBanner, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, ENGAGEMENT_LABEL } from "@/lib/format";

interface Worker {
  id: string; name: string; email: string | null; engagement: string; umbrella_name: string | null; company_name: string | null;
  ir35_status: string | null; kid_issued_on: string | null; active_placements: number;
}

export default function WorkersPage() {
  const { data, error } = useApi<Worker[]>("/api/rec/workers");
  return (
    <div className="stack">
      <PageHeader title="Workers" subtitle="Temporary workers and contractors, and how each one is engaged.">
        <Link className="btn primary" href="/workers/new">New worker</Link>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card>
        <DataTable rows={data}
          empty={<Empty title="No workers yet"><Link href="/workers/new">Register a worker</Link></Empty>}
          columns={[
            { key: "n", label: "Name", render: (w) => <>{w.name}{w.email && <div className="faint">{w.email}</div>}</> },
            { key: "e", label: "Engaged as", render: (w) => ENGAGEMENT_LABEL[w.engagement] },
            { key: "via", label: "Through", render: (w) => w.umbrella_name ?? w.company_name ?? "Agency payroll" },
            { key: "ir", label: "IR35", render: (w) => (w.engagement === "ltd" ? (w.ir35_status === "inside" ? <span className="pill signal">Inside</span> : <span className="pill">Outside</span>) : "–") },
            { key: "kid", label: "Key Information Document", render: (w) => (w.engagement === "ltd" ? "Not required" : w.kid_issued_on ? date(w.kid_issued_on) : <span className="pill signal">Missing</span>) },
            { key: "p", label: "Active placements", num: true, render: (w) => w.active_placements },
            { key: "a", label: "", render: (w) => <Link href={`/placements/new?worker=${w.id}`}>Place</Link> },
          ]} />
      </Card>
    </div>
  );
}
