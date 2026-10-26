"use client";

import Link from "next/link";
import { Card, DataTable, Empty, ErrorBanner, Loading, Money, PageHeader, Stat } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money, today } from "@/lib/format";
import type { MatterSummary } from "@law/lib/types";

interface Overview {
  clientMoney: string;
  officeOwed: string;
  wip: string;
  openMatters: number;
  lastReconciliation: { statement_date: string; balanced: boolean; signed_off_at: string | null } | null;
  nextReconciliationDue: string | null;
}

function reconciliationStatus(o: Overview): { value: string; sub: string; alert: boolean } {
  const last = o.lastReconciliation;
  if (!last) return { value: "Not started", sub: "Reconcile client account at least every five weeks", alert: true };
  const overdue = o.nextReconciliationDue! < today();
  if (overdue) return { value: "Overdue", sub: `Was due by ${date(o.nextReconciliationDue)}`, alert: true };
  if (!last.signed_off_at) return { value: "Awaiting sign-off", sub: `Statement date ${date(last.statement_date)}`, alert: true };
  return { value: `Due ${date(o.nextReconciliationDue)}`, sub: `Last signed off for ${date(last.statement_date)}`, alert: !last.balanced };
}

export default function DashboardPage() {
  const { data, error } = useApi<Overview>("/api/law/overview");
  const { data: matters } = useApi<MatterSummary[]>("/api/law/matters?status=open");

  return (
    <div className="stack">
      <PageHeader title="Dashboard" subtitle="Client money, billing and work in progress across the firm.">
        <Link className="btn" href="/reconciliation">Reconcile client account</Link>
        <Link className="btn primary" href="/matters?new=1">Open a matter</Link>
      </PageHeader>
      <ErrorBanner message={error} />
      {!data ? <div className="card"><Loading /></div> : (
        <div className="grid-4">
          <Stat label="Client money held" value={money(data.clientMoney)} sub="Across all client ledgers" href="/reconciliation" />
          <Stat label="Owed to the firm" value={money(data.officeOwed)} sub="Unpaid fee notes" />
          <Stat label="Unbilled time" value={money(data.wip)} sub={`${data.openMatters} open matters`} href="/matters" />
          <Stat label="Client account reconciliation" href="/reconciliation" {...reconciliationStatus(data)} />
        </div>
      )}
      <Card title="Open matters" actions={<Link className="btn small ghost" href="/matters">All matters</Link>}>
        <DataTable rows={matters} href={(r) => `/matters/${r.id}`}
          empty={<Empty title="No open matters">Open a matter to start taking money on account and recording time.</Empty>}
          columns={[
            { key: "number", label: "Matter", render: (r) => <span className="mono" style={{ whiteSpace: "nowrap" }}>{r.number}</span> },
            { key: "client", label: "Client", render: (r) => r.client_name },
            { key: "description", label: "Description", render: (r) => r.description },
            { key: "client_balance", label: "Client account", num: true, render: (r) => <Money value={r.client_balance} /> },
            { key: "office_balance", label: "Office (owed)", num: true, render: (r) => <Money value={r.office_balance} /> },
            { key: "wip", label: "Unbilled time", num: true, render: (r) => <Money value={r.wip} /> },
          ]} />
      </Card>
    </div>
  );
}
