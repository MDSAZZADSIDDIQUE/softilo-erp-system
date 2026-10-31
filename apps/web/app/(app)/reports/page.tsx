"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Card, DataTable, ErrorBanner, Loading, PageHeader, Tabs } from "@/components/ui";
import { useApi } from "@/lib/api";
import { amount, money, qty, today } from "@/lib/format";

type Row = { code: string; name: string; amount: string };

function Section({ title, rows, total }: { title: string; rows: Row[]; total: string }) {
  return (
    <>
      <tr><td colSpan={2} style={{ fontWeight: 500, background: "var(--surface-sunken)" }}>{title}</td></tr>
      {rows.map((r) => (
        <tr key={r.code + r.name}>
          <td>{r.code ? <Link href={`/accounts/${r.code}`}>{r.code} · {r.name}</Link> : r.name}</td>
          <td className="num">{amount(r.amount)}</td>
        </tr>
      ))}
      <tr><td style={{ fontWeight: 500 }}>Total {title.toLowerCase()}</td><td className="num" style={{ fontWeight: 500, borderTop: "1px solid var(--border-strong)" }}>{amount(total)}</td></tr>
    </>
  );
}

function ProfitAndLoss() {
  const year = new Date().getFullYear();
  const [range, setRange] = useState({ from: `${year}-01-01`, to: today() });
  const { data } = useApi<any>(`/api/reports/profit-and-loss?from=${range.from}&to=${range.to}`);
  return (
    <Card title="Profit and loss" actions={<RangePicker range={range} onChange={setRange} />}>
      {!data ? <Loading /> : (
        <table className="data">
          <tbody>
            <Section title="Income" rows={data.income} total={data.totals.income} />
            <Section title="Cost of sales" rows={data.costOfSales} total={data.totals.costOfSales} />
            <tr><td style={{ fontWeight: 500 }}>Gross profit {data.totals.grossMargin && <span className="muted">({data.totals.grossMargin}%)</span>}</td><td className="num" style={{ fontWeight: 500 }}>{amount(data.totals.grossProfit)}</td></tr>
            <Section title="Overheads" rows={data.overheads} total={data.totals.overheads} />
          </tbody>
          <tfoot><tr><td>Net profit</td><td className="num" style={{ fontSize: 16 }}>{money(data.totals.netProfit)}</td></tr></tfoot>
        </table>
      )}
    </Card>
  );
}

function BalanceSheet() {
  const [asAt, setAsAt] = useState(today());
  const { data } = useApi<any>(`/api/reports/balance-sheet?asAt=${asAt}`);
  return (
    <Card title="Balance sheet" actions={<input type="date" value={asAt} onChange={(e) => setAsAt(e.target.value)} aria-label="As at" />}>
      {!data ? <Loading /> : (
        <table className="data">
          <tbody>
            <Section title="Assets" rows={data.assets} total={data.totals.assets} />
            <Section title="Liabilities" rows={data.liabilities} total={data.totals.liabilities} />
            <tr><td style={{ fontWeight: 500 }}>Net assets</td><td className="num" style={{ fontWeight: 500 }}>{money(data.totals.netAssets)}</td></tr>
            <Section title="Capital and reserves" rows={data.equity} total={data.totals.equity} />
          </tbody>
          <tfoot><tr><td>{data.balanced ? "✓ Balances" : "Does not balance"}</td><td /></tr></tfoot>
        </table>
      )}
    </Card>
  );
}

function TrialBalance() {
  const [asAt, setAsAt] = useState(today());
  const { data } = useApi<any>(`/api/reports/trial-balance?asAt=${asAt}`);
  return (
    <Card title="Trial balance" actions={<input type="date" value={asAt} onChange={(e) => setAsAt(e.target.value)} aria-label="As at" />}>
      <DataTable rows={data?.rows as any[] | undefined} href={(r) => `/accounts/${r.code}`} columns={[
        { key: "c", label: "Code", render: (r) => r.code },
        { key: "n", label: "Account", render: (r) => r.name },
        { key: "d", label: "Debit", num: true, render: (r) => Number(r.debit) ? amount(r.debit) : "" },
        { key: "cr", label: "Credit", num: true, render: (r) => Number(r.credit) ? amount(r.credit) : "" },
      ]} footer={data && <tr><td colSpan={2}>{data.balanced ? "✓ Debits equal credits" : "Out of balance"}</td><td className="num">{amount(data.totals.debit)}</td><td className="num">{amount(data.totals.credit)}</td></tr>} />
    </Card>
  );
}

function Aged({ kind }: { kind: "debtors" | "creditors" }) {
  const { data } = useApi<any>(`/api/reports/aged-${kind}`);
  const cols = ["current", "d1_30", "d31_60", "d61_90", "d90_plus"] as const;
  const labels = ["Current", "1–30", "31–60", "61–90", "90+"];
  return (
    <Card title={kind === "debtors" ? "Aged debtors" : "Aged creditors"}>
      <DataTable rows={data?.rows as any[] | undefined} columns={[
        { key: "n", label: kind === "debtors" ? "Customer" : "Supplier", render: (r) => r.name },
        ...cols.map((c, i) => ({ key: c, label: labels[i]!, num: true, render: (r: any) => r[c] ? (
          <span style={c !== "current" ? { color: "var(--accent-text)" } : undefined}>{money(r[c], r.currency)}</span>) : "" })),
        { key: "t", label: "Total", num: true, render: (r) => <strong style={{ fontWeight: 500 }}>{money(r.total, r.currency)}</strong> },
      ]} />
    </Card>
  );
}

function StockValuation() {
  const { data } = useApi<any>("/api/reports/stock-valuation");
  return (
    <Card title="Stock valuation" actions={data && <span className={data.reconciled ? "pill quiet ok" : "pill signal"}>{data.reconciled ? "Agrees to ledger" : `Differs from ledger by ${money(data.difference)}`}</span>}>
      <DataTable rows={data?.rows as any[] | undefined} href={(r) => `/products/${r.id}`} columns={[
        { key: "s", label: "SKU", render: (r) => r.sku },
        { key: "n", label: "Product", render: (r) => r.name },
        { key: "w", label: "Warehouse", render: (r) => r.warehouse },
        { key: "q", label: "Quantity", num: true, render: (r) => qty(r.quantity) },
        { key: "a", label: "Avg landed cost", num: true, render: (r) => `£${Number(r.average_cost).toFixed(4)}` },
        { key: "v", label: "Value", num: true, render: (r) => money(r.value) },
      ]} footer={data && <tr><td colSpan={5}>Total (stock account: {money(data.ledgerValue)})</td><td className="num">{money(data.stockValue)}</td></tr>} />
    </Card>
  );
}

function Integrity() {
  const { data } = useApi<any>("/api/reports/integrity");
  if (!data) return <Card><Loading /></Card>;
  const rows = [
    { name: "Trial balance", detail: `Debits minus credits: ${money(data.trialBalance.difference)}`, ok: data.trialBalance.reconciled },
    { name: "Stock vs. stock account", detail: `${money(data.stock.stockValue)} in the warehouse, ${money(data.stock.ledgerValue)} in the ledger`, ok: data.stock.reconciled },
    { name: "Goods received not invoiced", detail: `${money(data.grni.unbilledReceipts)} unbilled receipts, ${money(data.grni.ledgerValue)} in the ledger`, ok: data.grni.reconciled },
    { name: "Stock movements vs. balances", detail: `${money(data.projection.movements)} from movements, ${money(data.projection.balances)} in balances`, ok: data.projection.reconciled },
  ];
  return (
    <Card title="Ledger integrity checks">
      <DataTable rows={rows} columns={[
        { key: "n", label: "Check", render: (r) => r.name },
        { key: "d", label: "Detail", render: (r) => <span className="muted">{r.detail}</span> },
        { key: "s", label: "Result", render: (r) => r.ok ? <span className="pill quiet ok">Agrees</span> : <span className="pill signal">Investigate</span> },
      ]} />
    </Card>
  );
}

function RangePicker({ range, onChange }: { range: { from: string; to: string }; onChange: (r: { from: string; to: string }) => void }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <input type="date" value={range.from} onChange={(e) => onChange({ ...range, from: e.target.value })} aria-label="From" />
      <span className="muted">to</span>
      <input type="date" value={range.to} onChange={(e) => onChange({ ...range, to: e.target.value })} aria-label="To" />
    </div>
  );
}

const TABS = [
  { id: "pl", label: "Profit and loss" }, { id: "bs", label: "Balance sheet" }, { id: "tb", label: "Trial balance" },
  { id: "aged-debtors", label: "Aged debtors" }, { id: "aged-creditors", label: "Aged creditors" },
  { id: "stock", label: "Stock valuation" }, { id: "integrity", label: "Integrity checks" },
];

export default function ReportsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = params.get("tab") ?? "pl";
  const { error } = useApi("/api/auth/me");
  return (
    <div className="stack">
      <PageHeader title="Reports" subtitle="Straight from the ledger. Every figure links back to its postings." />
      <ErrorBanner message={error} />
      <Tabs tabs={TABS} active={tab} onChange={(t) => router.replace(`/reports?tab=${t}`)} />
      {tab === "pl" && <ProfitAndLoss />}
      {tab === "bs" && <BalanceSheet />}
      {tab === "tb" && <TrialBalance />}
      {tab === "aged-debtors" && <Aged kind="debtors" />}
      {tab === "aged-creditors" && <Aged kind="creditors" />}
      {tab === "stock" && <StockValuation />}
      {tab === "integrity" && <Integrity />}
    </div>
  );
}
