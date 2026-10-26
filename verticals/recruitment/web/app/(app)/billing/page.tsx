"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, Loading, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date, money, today } from "@/lib/format";

interface Group {
  clientId: string; clientName: string; charge: string;
  timesheets: { id: string; number: string; week_ending: string; worker_name: string; job_title: string; hours: string; charge: string }[];
}

export default function BillingPage() {
  const router = useRouter();
  const { data, error } = useApi<Group[]>("/api/rec/billing");
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  async function raise(clientId: string) {
    setBusy(clientId);
    try {
      const r = await api<{ id: string }>("/api/rec/invoices", { body: { clientId, date: invoiceDate } });
      router.push(`/invoices/${r.id}`);
    } catch (err) {
      setActionError((err as Error).message);
      setBusy(undefined);
    }
  }

  return (
    <div className="stack">
      <PageHeader title="Ready to invoice" subtitle="Approved timesheets not yet billed, by client. Invoices include VAT and go to the sales ledger.">
        <label className="field" style={{ margin: 0 }}>
          <span>Invoice date</span>
          <input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
        </label>
      </PageHeader>
      <ErrorBanner message={error ?? actionError} />
      {!data && !error && <Card><Loading /></Card>}
      {data?.length === 0 && (
        <Card><Empty title="Nothing to invoice">Approved timesheets appear here. <Link href="/timesheets">See timesheets</Link></Empty></Card>
      )}
      {data?.map((g) => (
        <Card key={g.clientId} title={`${g.clientName} · ${money(g.charge)} net`}
          actions={<button className="btn primary" disabled={busy !== undefined} onClick={() => raise(g.clientId)}>{busy === g.clientId ? "Raising…" : "Raise invoice"}</button>}>
          <DataTable rows={g.timesheets} href={(t) => `/timesheets/${t.id}`} columns={[
            { key: "n", label: "Timesheet", render: (t) => t.number },
            { key: "w", label: "Week ending", render: (t) => date(t.week_ending) },
            { key: "who", label: "Worker", render: (t) => `${t.worker_name}, ${t.job_title}` },
            { key: "h", label: "Hours", num: true, render: (t) => Number(t.hours).toFixed(2) },
            { key: "c", label: "Net", num: true, render: (t) => money(t.charge) },
          ]} />
        </Card>
      ))}
    </div>
  );
}
