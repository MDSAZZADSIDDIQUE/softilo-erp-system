"use client";

import Link from "next/link";
import { Card, DataTable, Empty, ErrorBanner, Loading, PageHeader, Stat } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money, monthLabel, qty } from "@/lib/format";

interface Dashboard {
  cash: string; receivables: string; payables: string; stock: string; vatDue: string;
  overdue: { count: number; value: string };
  unreconciled: number;
  monthly: { month: string; sales: string | null; cost_of_sales: string | null }[];
  lowStock: { id: string; sku: string; name: string; on_hand: string; reorder_level: string }[];
  recent: { id: string; number: string; date: string; memo: string; source_type: string }[];
}

function SalesChart({ months }: { months: Dashboard["monthly"] }) {
  const max = Math.max(1, ...months.flatMap((m) => [Number(m.sales ?? 0), Number(m.cost_of_sales ?? 0)]));
  if (!months.length) return <Empty title="No sales yet">Sales and cost of sales for the last six months will appear here.</Empty>;
  return (
    <div className="card-pad">
      <div className="bars" role="img" aria-label="Sales and cost of sales by month">
        {months.map((m) => (
          <div className="bar-col" key={m.month}>
            <div className="bar-pair">
              <div className="bar sales" style={{ height: `${(Number(m.sales ?? 0) / max) * 100}%` }} title={`Sales ${money(m.sales)}`} />
              <div className="bar cost" style={{ height: `${(Number(m.cost_of_sales ?? 0) / max) * 100}%` }} title={`Cost of sales ${money(m.cost_of_sales)}`} />
            </div>
            <label>{monthLabel(m.month)}</label>
          </div>
        ))}
      </div>
      <div className="legend" style={{ marginTop: 12 }}>
        <span><i style={{ background: "var(--text)" }} />Sales</span>
        <span><i style={{ background: "var(--grey-300)" }} />Cost of sales</span>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { data, error } = useApi<Dashboard>("/api/dashboard");
  const { data: integrity } = useApi<{ allReconciled: boolean }>("/api/reports/integrity");

  return (
    <div className="stack">
      <PageHeader title="Dashboard" subtitle="Where the business stands today.">
        <Link className="btn" href="/purchase-orders/new">New purchase order</Link>
        <Link className="btn primary" href="/invoices/new">New invoice</Link>
      </PageHeader>
      <ErrorBanner message={error} />
      {!data ? <div className="card"><Loading /></div> : (
        <>
          <div className="grid-4">
            <Stat label="Cash at bank" value={money(data.cash)} sub={data.unreconciled ? `${data.unreconciled} bank lines to reconcile` : "Fully reconciled"} href="/banking" alert={data.unreconciled > 0} />
            <Stat label="Owed to you" value={money(data.receivables)} sub={data.overdue.count ? `${data.overdue.count} overdue · ${money(data.overdue.value)}` : "Nothing overdue"} alert={data.overdue.count > 0} href="/reports?tab=aged-debtors" />
            <Stat label="You owe" value={money(data.payables)} sub="Trade creditors" href="/reports?tab=aged-creditors" />
            <Stat label="Stock value" value={money(data.stock)} sub="At landed cost" href="/reports?tab=stock" />
          </div>
          <div className="grid-main">
            <Card title="Sales vs cost of sales">
              <SalesChart months={data.monthly} />
            </Card>
            <div className="stack">
              <Stat label="VAT position" value={money(data.vatDue)} sub={Number(data.vatDue) >= 0 ? "Owed to HMRC on open transactions" : "Due back from HMRC"} href="/vat" />
              <Card pad>
                <div className="label faint" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em" }}>Ledger checks</div>
                <p style={{ margin: "8px 0 0" }}>
                  {integrity === undefined ? "Checking…" : integrity.allReconciled
                    ? <>✓ Trial balance, stock and GRNI all reconcile.</>
                    : <span style={{ color: "var(--accent-text)" }}>A sub-ledger doesn&apos;t match its control account. <Link href="/reports?tab=integrity">See details</Link></span>}
                </p>
              </Card>
            </div>
          </div>
          <div className="grid-2">
            <Card title="Low stock" actions={<Link className="btn small ghost" href="/products">All products</Link>}>
              <DataTable rows={data.lowStock} href={(r) => `/products/${r.id}`}
                empty={<Empty title="Stock levels look healthy">Products at or below their reorder level show here.</Empty>}
                columns={[
                  { key: "sku", label: "SKU", render: (r) => r.sku },
                  { key: "name", label: "Product", render: (r) => r.name },
                  { key: "on", label: "On hand", num: true, render: (r) => <span style={{ color: "var(--accent-text)", fontWeight: 500 }}>{qty(r.on_hand)}</span> },
                  { key: "re", label: "Reorder at", num: true, render: (r) => qty(r.reorder_level) },
                ]} />
            </Card>
            <Card title="Recent postings" actions={<Link className="btn small ghost" href="/journals">All journals</Link>}>
              <DataTable rows={data.recent} href={(r) => `/journals/${r.id}`}
                columns={[
                  { key: "date", label: "Date", render: (r) => date(r.date) },
                  { key: "memo", label: "Description", render: (r) => r.memo },
                  { key: "n", label: "Journal", render: (r) => <span className="faint">{r.number}</span> },
                ]} />
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

