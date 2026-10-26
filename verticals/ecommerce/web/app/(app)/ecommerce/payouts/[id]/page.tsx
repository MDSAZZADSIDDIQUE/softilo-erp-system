"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Card, DataTable, ErrorBanner, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money } from "@/lib/format";
import { FEE_VAT_LABEL } from "@ecom/components/ecom";

interface Payout {
  id: string; number: string; external_id: string; date: string; channel_name: string; amount: string; sales: string; refunds: string;
  fees_net: string; fees_vat: string; fee_vat_code: string; reserves: string; adjustments: string; bank_account_code: string; journal_number: string; entry_id: string;
  lines: { line_no: number; kind: string; order_ref: string | null; amount: string; description: string; order_id: string | null; order_number: string | null }[];
  journal: { account_code: string; account_name: string; debit: string; credit: string; description: string | null }[];
}

const KIND: Record<string, string> = { order: "Sale", refund: "Refund", fee: "Fee", reserve: "Reserve", adjustment: "Adjustment" };

export default function PayoutPage() {
  const { id } = useParams<{ id: string }>();
  const { data: p, error } = useApi<Payout>(`/api/ecommerce/payouts/${id}`);
  if (!p) return <div className="stack"><PageHeader title="Payout" /><ErrorBanner message={error} /></div>;
  const rc = p.fee_vat_code === "RC20";
  return (
    <div className="stack">
      <PageHeader title={`Payout ${p.number}`} subtitle={`${p.channel_name} · ref ${p.external_id} · ${date(p.date)} · journal ${p.journal_number}`}>
        <Link className="btn ghost" href={`/journals/${p.entry_id}`}>View journal</Link>
      </PageHeader>
      <div className="grid-main">
        <Card title="Split">
          <div className="totals">
            <span>Sales collected</span><span className="mono num">{money(p.sales)}</span>
            <span>Refunds paid</span><span className="mono num">{money(`-${p.refunds}`)}</span>
            <span>Fees, net of VAT</span><span className="mono num">{money(`-${p.fees_net}`)}</span>
            <span>VAT on fees{rc ? " (self-accounted, not deducted)" : ""}</span><span className="mono num">{rc ? money(0) : money(`-${p.fees_vat}`)}</span>
            <span>Reserves</span><span className="mono num">{money(p.reserves)}</span>
            <span>Adjustments</span><span className="mono num">{money(p.adjustments)}</span>
            <span className="grand">Paid to bank ({p.bank_account_code})</span><span className="grand mono num">{money(p.amount)}</span>
          </div>
          <div className="card-pad faint" style={{ paddingTop: 0 }}>
            Fee VAT: {FEE_VAT_LABEL[p.fee_vat_code]}, {money(p.fees_vat)}{rc ? " posted to both output and input VAT (boxes 1 and 4)" : " reclaimable in box 4"}.
          </div>
        </Card>
        <Card title="Clearing journal">
          <DataTable rows={p.journal} columns={[
            { key: "a", label: "Account", render: (l) => <>{l.account_code} <span className="faint">{l.account_name}</span></> },
            { key: "d", label: "Debit", num: true, render: (l) => Number(l.debit) ? money(l.debit) : "" },
            { key: "c", label: "Credit", num: true, render: (l) => Number(l.credit) ? money(l.credit) : "" },
          ]} />
        </Card>
      </div>
      <Card title="Transactions">
        <DataTable rows={p.lines} columns={[
          { key: "k", label: "Type", render: (l) => KIND[l.kind] ?? l.kind },
          { key: "o", label: "Order", render: (l) => l.order_id ? <Link href={`/ecommerce/orders/${l.order_id}`}>{l.order_number}</Link> : (l.order_ref ?? "–") },
          { key: "d", label: "Description", render: (l) => l.description },
          { key: "a", label: "Amount", num: true, render: (l) => money(l.amount) },
        ]} />
      </Card>
    </div>
  );
}
