"use client";

import Link from "next/link";
import { Card, DataTable, Empty, ErrorBanner, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money } from "@/lib/format";

interface Payout { id: string; number: string; external_id: string; date: string; channel_name: string; amount: string; sales: string; refunds: string; fees_gross: string; fees_vat: string; reserves: string; journal_number: string }

export default function PayoutsPage() {
  const { data, error } = useApi<Payout[]>("/api/ecommerce/payouts");
  return (
    <div className="stack">
      <PageHeader title="Payouts" subtitle="Every payout split into sales, refunds, fees and VAT, reconciled to the bank" />
      <ErrorBanner message={error} />
      <Card>
        <DataTable rows={data} href={(p) => `/ecommerce/payouts/${p.id}`}
          empty={<Empty title="No payouts yet"><Link href="/ecommerce">Upload one from a channel</Link></Empty>}
          columns={[
            { key: "n", label: "Payout", render: (p) => <Link href={`/ecommerce/payouts/${p.id}`}>{p.number}</Link> },
            { key: "c", label: "Channel", render: (p) => p.channel_name },
            { key: "e", label: "Channel ref", render: (p) => p.external_id },
            { key: "d", label: "Date", render: (p) => date(p.date) },
            { key: "s", label: "Sales", num: true, render: (p) => money(p.sales) },
            { key: "r", label: "Refunds", num: true, render: (p) => money(`-${p.refunds}`) },
            { key: "f", label: "Fees", num: true, render: (p) => money(`-${p.fees_gross}`) },
            { key: "res", label: "Reserves", num: true, render: (p) => money(p.reserves) },
            { key: "a", label: "Paid to bank", num: true, render: (p) => <strong>{money(p.amount)}</strong> },
            { key: "j", label: "Journal", render: (p) => p.journal_number },
          ]} />
      </Card>
    </div>
  );
}
