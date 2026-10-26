"use client";

import Link from "next/link";
import { Card, DataTable, Stat } from "@core/components/ui";
import { date, qty } from "@core/lib/format";
import type { BatchStatus } from "@/components/fnb";

export interface Movement {
  id: string; date: string; kind: string; quantity: string; source_type: string; source_id: string | null; warehouse: string;
  contact_id: string | null; contact_name: string | null; document: string | null;
}
export interface Trace {
  generatedAt?: string;
  batch: { id: string; code: string; expiry: string | null; date_type: string; sku: string; product_name: string; product_id: string; received_on: string; status: BatchStatus };
  supplier: { id: string; name: string; email: string | null; phone: string | null; receipt: string | null; purchaseOrder: string | null } | null;
  totals: { received: string; dispatched: string; returned: string; writtenOff: string; onHand: string };
  customers: { id: string; name: string; quantity: string; firstDate: string; lastDate: string; documents: string[]; email: string | null; phone: string | null }[];
  movements: Movement[];
}

export const KIND: Record<string, string> = { receipt: "Received", dispatch: "Dispatched", return: "Returned", write_off: "Written off", adjustment: "Adjusted" };

export function documentLink(m: Movement) {
  if (!m.document || !m.source_id) return <span className="faint">–</span>;
  if (m.source_type === "sales_invoice") return <Link href={`/invoices/${m.source_id}`}>{m.document}</Link>;
  return m.document;
}

/** Recall trace: one step back and one step forward, printable for the FSA, the local authority or an auditor. */
export function TraceView({ trace }: { trace: Trace }) {
  const { batch, supplier, totals, customers } = trace;
  return (
    <>
      <div className="trace-summary">
        <Stat label="Received" value={qty(totals.received)} />
        <Stat label="Dispatched" value={qty(totals.dispatched)} sub={`${customers.length} ${customers.length === 1 ? "customer" : "customers"}`} alert={customers.length > 0 && batch.status === "expired"} />
        <Stat label="Returned" value={qty(totals.returned)} />
        <Stat label="Written off" value={qty(totals.writtenOff)} />
        <Stat label="On hand" value={qty(totals.onHand)} />
      </div>
      <div className="grid-main">
        <Card title="One step forward: customers supplied">
          <DataTable rows={customers} empty={<p className="muted card-pad">Nothing from this batch has been supplied to a customer.</p>} columns={[
            { key: "n", label: "Customer", render: (c) => <Link href={`/contacts?kind=customer`}>{c.name}</Link> },
            { key: "q", label: "Net quantity", num: true, render: (c) => qty(c.quantity) },
            { key: "d", label: "Supplied", render: (c) => c.firstDate === c.lastDate ? date(c.firstDate) : `${date(c.firstDate)} – ${date(c.lastDate)}` },
            { key: "docs", label: "Documents", render: (c) => c.documents.join(", ") },
            { key: "contact", label: "Contact", render: (c) => [c.email, c.phone].filter(Boolean).join(" · ") || <span className="faint">No contact details</span> },
          ]} />
        </Card>
        <Card title="One step back: supplier" pad>
          {supplier ? (
            <dl className="meta">
              <dt>Supplier</dt><dd>{supplier.name}</dd>
              <dt>Contact</dt><dd>{[supplier.email, supplier.phone].filter(Boolean).join(" · ") || "–"}</dd>
              <dt>Goods received</dt><dd>{supplier.receipt ?? "–"}</dd>
              <dt>Purchase order</dt><dd>{supplier.purchaseOrder ?? "–"}</dd>
              <dt>Received on</dt><dd>{date(batch.received_on)}</dd>
            </dl>
          ) : <p className="muted">No supplier recorded.</p>}
        </Card>
      </div>
    </>
  );
}
