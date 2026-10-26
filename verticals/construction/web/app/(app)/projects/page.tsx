"use client";

import Link from "next/link";
import { percent } from "@/components/cons";
import { Card, DataTable, Empty, ErrorBanner, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/api";
import { money } from "@/lib/format";

interface Project { id: string; code: string; name: string; status: string; customer_name: string; contract_value: string; budget: string; cost_to_date: string; valued_to_date: string; retention_rate: string; retention_held: string }

export default function ProjectsPage() {
  const { data, error } = useApi<Project[]>("/api/construction/projects");
  return (
    <div className="stack">
      <PageHeader title="Projects & job costing" subtitle="Budgets, costs and valuations for each contract.">
        <Link className="btn primary" href="/projects/new">New project</Link>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card>
        <DataTable rows={data} href={(p) => `/projects/${p.id}`}
          empty={<Empty title="No projects yet"><Link href="/projects/new">Set up a project</Link></Empty>}
          columns={[
            { key: "c", label: "Code", render: (p) => <Link href={`/projects/${p.id}`}>{p.code}</Link> },
            { key: "n", label: "Project", render: (p) => p.name },
            { key: "cu", label: "Customer", render: (p) => p.customer_name },
            { key: "r", label: "Retention", num: true, render: (p) => percent(p.retention_rate) },
            { key: "v", label: "Contract value", num: true, render: (p) => money(p.contract_value) },
            { key: "b", label: "Budget", num: true, render: (p) => money(p.budget) },
            { key: "k", label: "Cost to date", num: true, render: (p) => money(p.cost_to_date) },
            { key: "a", label: "Valued to date", num: true, render: (p) => money(p.valued_to_date) },
            { key: "h", label: "Retention held", num: true, render: (p) => money(p.retention_held) },
          ]} />
      </Card>
    </div>
  );
}
