"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Card, DataTable, ErrorBanner, Loading, PageHeader, paymentStatus, Status } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money } from "@/lib/format";

interface Bill {
  id: string; number: string; kind: string; supplier_id: string; supplier_name: string; supplier_ref: string; date: string; due_date: string;
  currency: string; rate: string; total: string; total_gbp: string; amount_paid: string; outstanding: string; entry_id: string; journal_number: string;
  lines: { line_no: number; kind: string; account_code: string | null; description: string; net: string; vat_code: string; vat: string }[];
}

export default function BillPage() {
  const { id } = useParams<{ id: string }>();
  const { data: b, error } = useApi<Bill>(`/api/supplier-bills/${id}`);
  if (!b) return error ? <ErrorBanner message={error} /> : <div className="card"><Loading /></div>;
  const status = b.kind === "credit" ? "credit" : paymentStatus({ ...b, overdue: b.due_date < new Date().toISOString().slice(0, 10) });
  return (
    <div className="stack">
      <PageHeader title={`${b.kind === "credit" ? "Supplier credit" : "Bill"} ${b.number}`} subtitle={<>{b.supplier_name} · ref {b.supplier_ref} · <Status value={status} /></>}>
        {b.kind === "bill" && Number(b.outstanding) > 0 && <Link className="btn primary" href={`/payments/new?direction=payment&contactId=${b.supplier_id}&documentId=${b.id}`}>Record payment</Link>}
      </PageHeader>
      <div className="grid-main">
        <Card title="Lines">
          <DataTable rows={b.lines} columns={[
            { key: "d", label: "Description", render: (l) => l.description },
            { key: "a", label: "Coded to", render: (l) => l.kind === "receipt" ? "Goods received" : l.account_code },
            { key: "n", label: "Net", num: true, render: (l) => money(l.net, b.currency) },
            { key: "vc", label: "VAT code", render: (l) => l.vat_code },
            { key: "v", label: "VAT", num: true, render: (l) => money(l.vat, b.currency) },
          ]} footer={<tr><td colSpan={4}>Total</td><td className="num">{money(b.total, b.currency)}</td></tr>} />
        </Card>
        <Card title="Summary" pad>
          <dl className="meta">
            <dt>Bill date</dt><dd>{date(b.date)}</dd>
            <dt>Due</dt><dd>{date(b.due_date)}</dd>
            <dt>Total</dt><dd>{money(b.total, b.currency)}</dd>
            {b.currency !== "GBP" && <><dt>In GBP</dt><dd>{money(b.total_gbp)} @ {Number(b.rate)}</dd></>}
            <dt>Paid</dt><dd>{money(b.amount_paid, b.currency)}</dd>
            <dt>Outstanding</dt><dd><strong>{money(b.outstanding, b.currency)}</strong></dd>
            <dt>Journal</dt><dd><Link href={`/journals/${b.entry_id}`}>{b.journal_number}</Link></dd>
          </dl>
        </Card>
      </div>
    </div>
  );
}
