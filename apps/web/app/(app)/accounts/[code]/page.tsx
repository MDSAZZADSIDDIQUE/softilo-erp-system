"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Card, DataTable, ErrorBanner, Loading, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/api";
import { amount, date } from "@/lib/format";

interface Ledger {
  account: { code: string; name: string; type: string };
  opening: string; closing: string;
  lines: { entry_id: string; number: string; date: string; memo: string; description: string | null; debit: string; credit: string; balance: string }[];
}

export default function AccountLedgerPage() {
  const { code } = useParams<{ code: string }>();
  const [range, setRange] = useState({ from: "", to: "" });
  const qs = new URLSearchParams(Object.entries(range).filter(([, v]) => v)).toString();
  const { data, error } = useApi<Ledger>(`/api/accounts/${code}/ledger${qs ? `?${qs}` : ""}`);
  if (!data) return error ? <ErrorBanner message={error} /> : <div className="card"><Loading /></div>;
  return (
    <div className="stack">
      <PageHeader title={`${data.account.code} · ${data.account.name}`} subtitle={`Closing balance ${amount(data.closing)} (debit positive)`}>
        <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} aria-label="From" />
        <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} aria-label="To" />
      </PageHeader>
      <Card>
        <DataTable rows={data.lines} href={(l) => `/journals/${l.entry_id}`} columns={[
          { key: "d", label: "Date", render: (l) => date(l.date) },
          { key: "n", label: "Journal", render: (l) => <Link href={`/journals/${l.entry_id}`}>{l.number}</Link> },
          { key: "m", label: "Description", render: (l) => l.description ? `${l.memo} · ${l.description}` : l.memo },
          { key: "dr", label: "Debit", num: true, render: (l) => Number(l.debit) ? amount(l.debit) : "" },
          { key: "cr", label: "Credit", num: true, render: (l) => Number(l.credit) ? amount(l.credit) : "" },
          { key: "b", label: "Balance", num: true, render: (l) => amount(l.balance) },
        ]} footer={range.from ? <tr><td colSpan={5}>Opening balance {amount(data.opening)}</td><td className="num">{amount(data.closing)}</td></tr> : undefined} />
      </Card>
    </div>
  );
}
