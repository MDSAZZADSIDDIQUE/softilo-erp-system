"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import CoreInvoicePage from "@core/app/(app)/invoices/[id]/page";
import { Card, DataTable } from "@core/components/ui";
import { useApi } from "@core/lib/api";
import { qty } from "@core/lib/format";
import { DateMark } from "@/components/fnb";

interface Row { line_no: number; sku: string; batch_id: string; code: string; expiry: string | null; date_type: string; quantity: string }

/** The core invoice, plus the batches it was supplied from (one step forward for traceability). */
export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const { data } = useApi<Row[]>(`/api/fnb/sales-invoices/${id}/batches`);
  return (
    <div className="stack">
      <CoreInvoicePage />
      {data && data.length > 0 && (
        <Card title="Batches supplied">
          <DataTable rows={data} columns={[
            { key: "l", label: "Line", render: (r) => r.line_no },
            { key: "s", label: "SKU", render: (r) => r.sku },
            { key: "b", label: "Batch", render: (r) => <Link className="batch-code" href={`/fnb/batches/${r.batch_id}`}>{r.code}</Link> },
            { key: "d", label: "Date mark", render: (r) => <DateMark expiry={r.expiry} type={r.date_type} /> },
            { key: "q", label: "Quantity", num: true, render: (r) => qty(r.quantity) },
          ]} />
        </Card>
      )}
    </div>
  );
}
