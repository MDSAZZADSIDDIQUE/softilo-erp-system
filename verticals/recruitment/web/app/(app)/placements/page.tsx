"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, PageHeader, RecStatus, Tabs } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, ENGAGEMENT_LABEL, money } from "@/lib/format";

interface PlacementRow {
  id: string; number: string; client_name: string; worker_name: string; engagement: string; ir35_status: string | null;
  consultant_name: string | null; job_title: string; start_date: string; end_date: string | null; status: string;
  pay_rate: string; charge_rate: string; min_spread: string;
}

export default function PlacementsPage() {
  const { data, error } = useApi<PlacementRow[]>("/api/rec/placements");
  const [tab, setTab] = useState("active");
  const rows = data?.filter((p) => tab === "all" || p.status === tab);
  return (
    <div className="stack">
      <PageHeader title="Placements" subtitle="Temporary and contract assignments, with their pay and charge rates.">
        <Link className="btn primary" href="/placements/new">New placement</Link>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card>
        <div className="card-pad" style={{ paddingBottom: 0 }}>
          <Tabs active={tab} onChange={setTab} tabs={[{ id: "active", label: "Active" }, { id: "ended", label: "Ended" }, { id: "all", label: "All" }]} />
        </div>
        <DataTable rows={rows} href={(p) => `/placements/${p.id}`}
          empty={<Empty title="No placements yet"><Link href="/placements/new">Place a worker</Link></Empty>}
          columns={[
            { key: "n", label: "Number", render: (p) => <Link href={`/placements/${p.id}`}>{p.number}</Link> },
            { key: "w", label: "Worker", render: (p) => <>{p.worker_name}<div className="faint">{ENGAGEMENT_LABEL[p.engagement]}{p.ir35_status ? `, ${p.ir35_status} IR35` : ""}</div></> },
            { key: "c", label: "Client and role", render: (p) => <>{p.client_name}<div className="faint">{p.job_title}</div></> },
            { key: "k", label: "Consultant", render: (p) => p.consultant_name ?? "–" },
            { key: "d", label: "Dates", render: (p) => `${date(p.start_date)} – ${p.end_date ? date(p.end_date) : "ongoing"}` },
            { key: "pay", label: "Pay", num: true, render: (p) => money(p.pay_rate) },
            { key: "chg", label: "Charge", num: true, render: (p) => money(p.charge_rate) },
            { key: "s", label: "Status", render: (p) => <RecStatus value={p.status} /> },
          ]} />
      </Card>
    </div>
  );
}
