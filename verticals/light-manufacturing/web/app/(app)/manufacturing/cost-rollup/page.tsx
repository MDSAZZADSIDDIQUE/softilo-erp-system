"use client";

import Link from "next/link";
import { Card, DataTable, Empty, ErrorBanner, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/api";
import { qty } from "@/lib/format";
import { CostBar, CostLegend, unitCost } from "@mfg/components/mfg";

interface Row {
  id: string; sku: string; name: string; on_hand: string; average_cost: string | null;
  material: string; labour: string; overhead: string; total: string; missingCosts: string[];
}

export default function CostRollupPage() {
  const { data, error } = useApi<Row[]>("/api/mfg/cost-rollup");
  return (
    <div className="stack">
      <PageHeader title="Cost roll-up"
        subtitle="Standard cost per unit for every product with an active BOM: bought-in parts at average cost, plus labour and overhead at work-centre rates, through every level." />
      <ErrorBanner message={error} />
      <Card actions={<CostLegend />} title="Products made">
        <DataTable rows={data} href={(r) => `/products/${r.id}`}
          empty={<Empty title="Nothing to cost yet"><Link href="/manufacturing/boms/new">Create a bill of materials</Link></Empty>}
          columns={[
            { key: "s", label: "Product", render: (r) => <><strong>{r.sku}</strong> <span className="muted">{r.name}</span></> },
            { key: "m", label: "Material", num: true, render: (r) => unitCost(r.material) },
            { key: "l", label: "Labour", num: true, render: (r) => unitCost(r.labour) },
            { key: "o", label: "Overhead", num: true, render: (r) => unitCost(r.overhead) },
            { key: "t", label: "Standard cost", num: true, render: (r) => <strong>{unitCost(r.total)}</strong> },
            { key: "b", label: "Split", render: (r) => <div style={{ minWidth: 120 }}><CostBar {...r} /></div> },
            { key: "h", label: "On hand", num: true, render: (r) => qty(r.on_hand) },
            { key: "a", label: "Average cost held", num: true, render: (r) => unitCost(r.average_cost) },
            { key: "x", label: "Missing costs", render: (r) => r.missingCosts.length ? <span className="pill signal">{r.missingCosts.join(", ")}</span> : <span className="muted">–</span> },
          ]} />
      </Card>
    </div>
  );
}
