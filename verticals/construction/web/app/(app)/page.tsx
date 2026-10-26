"use client";

import Link from "next/link";
import { CisPill, taxMonthEndFor } from "@/components/cons";
import { Card, DataTable, Empty, ErrorBanner, PageHeader, Stat } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money, sumPence, today } from "@/lib/format";

interface Project { id: string; code: string; name: string; customer_name: string; contract_value: string; cost_to_date: string; valued_to_date: string; retention_held: string; budget: string }
interface Sub { contact_id: string; name: string; cis_status: string }
interface Cis { month: { end: string; returnDue: string; paymentDue: string }; totals: { amountDeducted: string; subcontractors: number }; nil: boolean; submitted: unknown }

export default function Dashboard() {
  const projects = useApi<Project[]>("/api/construction/projects");
  const subs = useApi<Sub[]>("/api/construction/subcontractors");
  const month = taxMonthEndFor(today());
  const cis = useApi<Cis>(`/api/construction/cis/preview?monthEnding=${month}`);
  const unverified = (subs.data ?? []).filter((s) => s.cis_status === "unverified");
  const rows = projects.data ?? [];
  return (
    <div className="stack">
      <PageHeader title="Dashboard" subtitle="Work in progress, retentions and this month's CIS." />
      <ErrorBanner message={projects.error ?? cis.error} />
      <div className="grid-4">
        <Stat label="Contract value" value={money(sumPence(rows.map((p) => p.contract_value)))} sub={`${rows.length} project${rows.length === 1 ? "" : "s"}`} href="/projects" />
        <Stat label="Valued to date" value={money(sumPence(rows.map((p) => p.valued_to_date)))} sub={`Cost to date ${money(sumPence(rows.map((p) => p.cost_to_date)))}`} />
        <Stat label="Retention held" value={money(sumPence(rows.map((p) => p.retention_held)))} sub="Released at completion and after defects" href="/applications" />
        <Stat label="CIS this month" value={money(cis.data?.totals.amountDeducted ?? 0)}
          sub={cis.data ? (cis.data.submitted ? "Return submitted" : `Return due ${date(cis.data.month.returnDue)}`) : undefined}
          alert={Boolean(cis.data && !cis.data.submitted)} href="/cis" />
      </div>
      {unverified.length > 0 && (
        <div className="banner error" role="status">
          {unverified.length} subcontractor{unverified.length === 1 ? " needs" : "s need"} verifying with HMRC before you can enter their bills. <Link href="/subcontractors">Verify now</Link>
        </div>
      )}
      <Card title="Projects" actions={<Link className="btn small" href="/projects/new">New project</Link>}>
        <DataTable rows={projects.data} href={(p) => `/projects/${p.id}`}
          empty={<Empty title="No projects yet"><Link href="/projects/new">Set up your first project</Link></Empty>}
          columns={[
            { key: "c", label: "Code", render: (p) => <Link href={`/projects/${p.id}`}>{p.code}</Link> },
            { key: "n", label: "Project", render: (p) => p.name },
            { key: "cu", label: "Customer", render: (p) => p.customer_name },
            { key: "v", label: "Contract value", num: true, render: (p) => money(p.contract_value) },
            { key: "a", label: "Valued", num: true, render: (p) => money(p.valued_to_date) },
            { key: "k", label: "Cost", num: true, render: (p) => money(p.cost_to_date) },
            { key: "m", label: "Margin to date", num: true, render: (p) => money(sumPence([p.valued_to_date, `-${p.cost_to_date}`])) },
          ]} />
      </Card>
      <Card title="Subcontractors" actions={<Link className="btn small" href="/subcontractors">Manage</Link>}>
        <DataTable rows={subs.data} empty={<Empty title="No subcontractors yet" />}
          columns={[
            { key: "n", label: "Name", render: (s) => s.name },
            { key: "s", label: "CIS status", render: (s) => <CisPill status={s.cis_status} /> },
          ]} />
      </Card>
    </div>
  );
}
