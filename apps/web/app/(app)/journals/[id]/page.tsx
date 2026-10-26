"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Card, DataTable, ErrorBanner, Loading, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { amount, dateTime, date, money, today } from "@/lib/format";

interface Journal {
  id: string; number: string; date: string; memo: string; source_type: string; source_id: string | null; reverses_id: string | null;
  created_by_name: string | null; created_at: string;
  lines: { line_no: number; account_code: string; account_name: string; debit: string; credit: string; description: string | null }[];
  vat: { direction: string; vat_code: string; net: string; vat: string; vat_return_id: string | null }[];
}

const SOURCE_LINK: Record<string, (id: string) => string> = {
  sales_invoice: (id) => `/invoices/${id}`,
  supplier_bill: (id) => `/bills/${id}`,
  shipment: (id) => `/shipments/${id}`,
};

export default function JournalPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: j, error } = useApi<Journal>(`/api/journals/${id}`);
  const [actionError, setActionError] = useState<string>();
  if (!j) return error ? <ErrorBanner message={error} /> : <div className="card"><Loading /></div>;
  const total = j.lines.reduce((s, l) => s + Number(l.debit), 0);
  const link = j.source_id && SOURCE_LINK[j.source_type]?.(j.source_id);

  async function reverse() {
    const d = prompt("Date for the reversing entry (YYYY-MM-DD)", today());
    if (!d) return;
    try {
      const r = await api<{ id: string }>(`/api/journals/${id}/reverse`, { body: { date: d } });
      router.push(`/journals/${r.id}`);
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  return (
    <div className="stack">
      <PageHeader title={`Journal ${j.number}`} subtitle={<>{j.memo} · {date(j.date)}</>}>
        {link && <Link className="btn" href={link}>Open source document</Link>}
        {j.reverses_id && <Link className="btn" href={`/journals/${j.reverses_id}`}>Reversed entry</Link>}
        {j.source_type === "manual" && !j.reverses_id && <button className="btn" onClick={reverse}>Reverse</button>}
      </PageHeader>
      <ErrorBanner message={actionError} />
      <Card title="Lines" actions={<span className="muted">Posted by {j.created_by_name ?? "system"} · {dateTime(j.created_at)}</span>}>
        <DataTable rows={j.lines} href={(l) => `/accounts/${l.account_code}`} columns={[
          { key: "a", label: "Account", render: (l) => `${l.account_code} · ${l.account_name}` },
          { key: "d", label: "Description", render: (l) => l.description ?? "" },
          { key: "dr", label: "Debit", num: true, render: (l) => Number(l.debit) ? amount(l.debit) : "" },
          { key: "cr", label: "Credit", num: true, render: (l) => Number(l.credit) ? amount(l.credit) : "" },
        ]} footer={<tr><td colSpan={2}>Total</td><td className="num">{amount(total)}</td><td className="num">{amount(total)}</td></tr>} />
      </Card>
      {j.vat.length > 0 && (
        <Card title="VAT recorded">
          <DataTable rows={j.vat} columns={[
            { key: "d", label: "", render: (v) => v.direction === "sales" ? "Sales" : "Purchases" },
            { key: "c", label: "Code", render: (v) => v.vat_code },
            { key: "n", label: "Net", num: true, render: (v) => money(v.net) },
            { key: "v", label: "VAT", num: true, render: (v) => money(v.vat) },
            { key: "r", label: "Return", render: (v) => v.vat_return_id ? <span className="pill quiet ok">Filed</span> : <span className="pill">Open</span> },
          ]} />
        </Card>
      )}
    </div>
  );
}
