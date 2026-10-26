"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/api";
import { qty } from "@/lib/format";
import { MfgStatus } from "@mfg/components/mfg";

interface Row {
  productId: string; sku: string; name: string; uom: string; level: number;
  demand: string; onHand: string; onOrder: string; inProduction: string; shortage: string; action: "make" | "buy" | null;
}

export default function MrpPage() {
  const { data, error } = useApi<Row[]>("/api/mfg/mrp");
  const [onlyShort, setOnlyShort] = useState(true);
  const rows = onlyShort ? data?.filter((r) => r.action) : data;
  return (
    <div className="stack">
      <PageHeader title="Shortages (MRP)"
        subtitle="Components still to issue on open works orders, netted level by level against stock, open purchase orders and output already in production.">
        <label className="checkbox"><input type="checkbox" checked={onlyShort} onChange={(e) => setOnlyShort(e.target.checked)} /> Only show shortages</label>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card>
        <DataTable rows={rows}
          empty={<Empty title={onlyShort ? "Nothing is short" : "No open demand"}>{onlyShort ? "Every open works order is covered." : "There are no open works orders."}</Empty>}
          columns={[
            { key: "l", label: "Level", num: true, render: (r) => <span className="level" title="0 = finished product; higher = deeper in the BOM">{r.level}</span> },
            { key: "s", label: "Item", render: (r) => <><Link href={`/products/${r.productId}`}>{r.sku}</Link> <span className="muted">{r.name}</span></> },
            { key: "d", label: "Needed", num: true, render: (r) => `${qty(r.demand)} ${r.uom}` },
            { key: "h", label: "On hand", num: true, render: (r) => qty(r.onHand) },
            { key: "o", label: "On order", num: true, render: (r) => qty(r.onOrder) },
            { key: "p", label: "In production", num: true, render: (r) => qty(r.inProduction) },
            { key: "x", label: "Short", num: true, render: (r) => Number(r.shortage) > 0 ? <strong>{qty(r.shortage)}</strong> : "–" },
            { key: "a", label: "Action", render: (r) => <MfgStatus value={r.action} /> },
            { key: "go", label: "", num: true, render: (r) => r.action === "make"
              ? <Link className="btn small" href={`/manufacturing/works-orders/new?product=${r.productId}&quantity=${Number(r.shortage)}`}>Plan works order</Link>
              : r.action === "buy" ? <Link className="btn small" href="/purchase-orders/new">Raise purchase order</Link> : null },
          ]} />
      </Card>
    </div>
  );
}
