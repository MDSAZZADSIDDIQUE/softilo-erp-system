"use client";

import { Card, DataTable, ErrorBanner, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/api";
import { dateTime } from "@/lib/format";

interface Event { id: string; action: string; entity: string; entity_id: string | null; at: string; user_name: string | null; ip: string | null; hash: string }

export default function AuditPage() {
  const { data, error } = useApi<Event[]>("/api/audit");
  return (
    <div className="stack">
      <PageHeader title="Audit trail" subtitle="Who did what, and when. Each event is hash-chained to the one before, so the log can't be quietly altered." />
      <ErrorBanner message={error} />
      <Card>
        <DataTable rows={data} columns={[
          { key: "t", label: "When", render: (e) => dateTime(e.at) },
          { key: "u", label: "Who", render: (e) => e.user_name ?? "System" },
          { key: "a", label: "Action", render: (e) => e.action.replace(/[._]/g, " ") },
          { key: "e", label: "Record", render: (e) => <span className="faint">{e.entity}</span> },
          { key: "ip", label: "IP", render: (e) => e.ip ?? <span className="faint">–</span> },
          { key: "h", label: "Hash", render: (e) => <span className="mono faint" title={e.hash}>{e.hash.slice(0, 12)}…</span> },
        ]} />
      </Card>
    </div>
  );
}
