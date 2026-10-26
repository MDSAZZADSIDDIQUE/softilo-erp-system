"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Card, DataTable, ErrorBanner, Loading, PageHeader, Stat } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { money, qty } from "@/lib/format";
import { CostBar, CostLegend, unitCost } from "@mfg/components/mfg";

interface Bom {
  id: string; sku: string; name: string; version: number; output_qty: string; is_active: boolean; product_id: string;
  lines: { line_no: number; component_id: string; sku: string; name: string; uom: string; quantity: string; wastage_pct: string; made: boolean }[];
  operations: { seq: number; description: string; code: string; name: string; setup_hours: string; run_hours_per_unit: string; labour_rate: string; overhead_rate: string }[];
  rollup: {
    material: string; labour: string; overhead: string; total: string; missingCosts: string[];
    components: { productId: string; quantityPerUnit: string; unitCost: string; extended: string; made: boolean }[];
  };
}

export default function BomPage() {
  const { id } = useParams<{ id: string }>();
  const { data: b, error, reload } = useApi<Bom>(`/api/mfg/boms/${id}`);
  const [actionError, setActionError] = useState<string>();
  if (!b) return <div className="stack"><ErrorBanner message={error} /><Card><Loading /></Card></div>;
  const cost = new Map(b.rollup.components.map((c) => [c.productId, c]));

  async function activate() {
    try {
      await api(`/api/mfg/boms/${id}/activate`, { body: {} });
      await reload();
    } catch (err) {
      setActionError((err as Error).message);
    }
  }

  return (
    <div className="stack">
      <PageHeader title={`${b.sku} · v${b.version}`} subtitle={<>{b.name}. Makes {qty(b.output_qty)} per batch. {b.is_active ? "Active version." : "Inactive version."}</>}>
        {!b.is_active && <button className="btn" onClick={activate}>Make active</button>}
        <Link className="btn" href={`/manufacturing/boms/new?from=${b.id}`}>New version</Link>
        {b.is_active && <Link className="btn primary" href={`/manufacturing/works-orders/new?product=${b.product_id}`}>Plan a works order</Link>}
      </PageHeader>
      <ErrorBanner message={actionError} />
      {b.rollup.missingCosts.length > 0 && (
        <div className="banner error" role="status">No cost yet for {b.rollup.missingCosts.join(", ")}: receive stock or a purchase for them to complete the roll-up.</div>
      )}
      <div className="grid-4">
        <Stat label="Standard cost per unit" value={unitCost(b.rollup.total)} sub={<CostBar {...b.rollup} />} />
        <Stat label="Material" value={unitCost(b.rollup.material)} sub="Average cost, rolled up through sub-assemblies" />
        <Stat label="Labour" value={unitCost(b.rollup.labour)} sub="Standard labour rates" />
        <Stat label="Overhead" value={unitCost(b.rollup.overhead)} sub="Absorbed at normal capacity" />
      </div>
      <Card title="Components" actions={<CostLegend />}>
        <DataTable rows={b.lines} columns={[
          { key: "s", label: "Component", render: (l) => <Link href={`/products/${l.component_id}`}>{l.sku}</Link> },
          { key: "n", label: "Name", render: (l) => <>{l.name} {l.made && <span className="pill quiet">Sub-assembly</span>}</> },
          { key: "q", label: "Per batch", num: true, render: (l) => `${qty(l.quantity)} ${l.uom}` },
          { key: "w", label: "Wastage", num: true, render: (l) => `${qty(l.wastage_pct)}%` },
          { key: "u", label: "Per unit", num: true, render: (l) => qty(cost.get(l.component_id)?.quantityPerUnit) },
          { key: "c", label: "Unit cost", num: true, render: (l) => unitCost(cost.get(l.component_id)?.unitCost) },
          { key: "e", label: "Cost per unit made", num: true, render: (l) => unitCost(cost.get(l.component_id)?.extended) },
        ]} />
      </Card>
      <Card title="Routing">
        <DataTable rows={b.operations} empty={<div className="card-pad muted">No operations: this product is costed on materials only.</div>} columns={[
          { key: "s", label: "Step", num: true, render: (o) => o.seq },
          { key: "d", label: "Operation", render: (o) => o.description },
          { key: "w", label: "Work centre", render: (o) => <>{o.code} <span className="muted">{o.name}</span></> },
          { key: "su", label: "Setup (h/batch)", num: true, render: (o) => qty(o.setup_hours) },
          { key: "r", label: "Run (h/unit)", num: true, render: (o) => qty(o.run_hours_per_unit) },
          { key: "rate", label: "Rates (labour + overhead)", num: true, render: (o) => `${money(o.labour_rate)} + ${money(o.overhead_rate)} /h` },
        ]} />
      </Card>
    </div>
  );
}
