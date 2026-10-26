"use client";

import Link from "next/link";
import { Card, DataTable, Empty, ErrorBanner, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, qty } from "@/lib/format";

interface BomRow { id: string; sku: string; name: string; version: number; output_qty: string; is_active: boolean; line_count: string; operation_count: string; created_at: string }

export default function BomsPage() {
  const { data, error } = useApi<BomRow[]>("/api/mfg/boms");
  return (
    <div className="stack">
      <PageHeader title="Bills of materials" subtitle="What goes into each product, and the routing to make it. A component with its own BOM is a sub-assembly.">
        <Link className="btn primary" href="/manufacturing/boms/new">New bill of materials</Link>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card>
        <DataTable rows={data} href={(b) => `/manufacturing/boms/${b.id}`}
          empty={<Empty title="No bills of materials yet"><Link href="/manufacturing/boms/new">Create the first one</Link></Empty>}
          columns={[
            { key: "p", label: "Product", render: (b) => <Link href={`/manufacturing/boms/${b.id}`}>{b.sku}</Link> },
            { key: "n", label: "Name", render: (b) => b.name },
            { key: "v", label: "Version", num: true, render: (b) => `v${b.version}` },
            { key: "o", label: "Makes", num: true, render: (b) => qty(b.output_qty) },
            { key: "l", label: "Components", num: true, render: (b) => b.line_count },
            { key: "r", label: "Operations", num: true, render: (b) => b.operation_count },
            { key: "s", label: "Status", render: (b) => b.is_active ? <span className="pill solid">Active</span> : <span className="pill quiet">Inactive</span> },
            { key: "d", label: "Created", render: (b) => date(b.created_at) },
          ]} />
      </Card>
    </div>
  );
}
