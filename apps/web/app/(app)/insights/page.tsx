"use client";

import Link from "next/link";
import { useState } from "react";
import { BarList, LineChart, PairedColumns, compact } from "@/components/charts";
import { Card, DataTable, Empty, ErrorBanner, Loading, PageHeader, Tabs } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money, qty, today } from "@/lib/format";

interface Kpis { debtorDays: number | null; creditorDays: number | null; stockDays: number | null; stockTurn: number | null; grossMarginPct: number | null; sales90: number }
interface Week { week: number; from: string; to: string; inflow: number; outflow: number; closing: number; items: { label: string; amount: number; kind: string; href?: string }[] }
interface Forecast { opening: number; closing: number; lowest: { week: number; from: string; closing: number }; weeks: Week[] }
interface MarginRow { key: string; label: string; revenue: number; cost: number; margin: number; marginPct: number | null; quantity: number; invoices: number }
interface Margin { rows: MarginRow[]; totals: { revenue: number; cost: number; margin: number; marginPct: number | null } }
interface Fx { currencies: { currency: string; rateToday: number; payable: number; onOrder: number; receivable: number; net: number; gbpAtBookedRates: number; gbpAtToday: number; unrealised: number; fivePercentMove: number }[]; realisedThisYear: number }
interface StockItem { id: string; sku: string; name: string; onHand: number; value: number; perWeek: number; daysCover: number | null; onOrder: number; reorderLevel: number | null; lastSold: string | null; status: string }
interface Supplier { id: string; name: string; currency: string; orders: number; spendGbp: number; averageLeadDays: number | null; priceVarianceGbp: number; priceChangePct: number | null }
interface Shipment { id: string; number: string; reference: string | null; date: string; status: string; goods: number; costs: number; upliftPct: number; costPerKg: number | null }
interface Anomaly { severity: string; kind: string; title: string; detail: string; href?: string }

const shortDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const STOCK_STATUS: Record<string, string> = { reorder: "Reorder", dead: "Not selling", slow: "Slow", healthy: "Healthy" };

function CashForecast() {
  const { data, error } = useApi<Forecast>("/api/analytics/cash-forecast");
  const [table, setTable] = useState(false);
  if (error) return <ErrorBanner message={error} />;
  if (!data) return <Card title="Cash, next 13 weeks"><Loading /></Card>;
  return (
    <Card title="Cash, next 13 weeks" actions={<button className="btn small ghost" onClick={() => setTable((t) => !t)}>{table ? "Show chart" : "Show table"}</button>}>
      <div className="card-pad stack" style={{ gap: 16 }}>
        <p className="muted" style={{ margin: 0 }}>
          From {money(data.opening)} today to {money(data.closing)} by week 13. The low point is <strong style={{ color: "var(--text)", fontWeight: 500 }}>{money(data.lowest.closing)}</strong> in the week of {shortDate(data.lowest.from)}.
          Receipts are moved by how late each customer usually pays; approved orders are paid on the supplier&apos;s terms after arrival; payroll and direct debits repeat at their recent average.
        </p>
        {table ? (
          <DataTable rows={data.weeks} columns={[
            { key: "w", label: "Week of", render: (w) => shortDate(w.from) },
            { key: "in", label: "Money in", num: true, render: (w) => money(w.inflow) },
            { key: "out", label: "Money out", num: true, render: (w) => money(w.outflow) },
            { key: "bal", label: "Closing balance", num: true, render: (w) => money(w.closing) },
            { key: "what", label: "Largest items", render: (w) => <span className="muted">{w.items.slice(0, 2).map((i) => i.label).join("; ") || "–"}</span> },
          ]} />
        ) : (
          <>
            <LineChart ariaLabel={`Projected closing bank balance by week, lowest ${money(data.lowest.closing)}`}
              points={data.weeks.map((w) => ({ label: shortDate(w.from), value: w.closing, detail: <small>{w.items.length ? `${w.items.length} expected payments` : "Nothing due"}</small> }))} />
            <PairedColumns ariaLabel="Money in and money out by week" labels={["Money in", "Money out"]}
              rows={data.weeks.map((w) => ({ label: shortDate(w.from), a: w.inflow, b: w.outflow,
                detail: w.items.slice(0, 3).map((i, k) => <small key={k}>{i.label}: {compact(i.amount)}</small>) }))} />
          </>
        )}
      </div>
    </Card>
  );
}

function Margins() {
  const [by, setBy] = useState("product");
  const { data } = useApi<Margin>(`/api/analytics/margin?by=${by}`);
  const rows = data?.rows ?? [];
  return (
    <Card title="Gross margin, last six months" actions={data?.totals.marginPct != null && <span className="muted">{data.totals.marginPct}% on {money(data.totals.revenue)}</span>}>
      <div className="card-pad" style={{ paddingBottom: 0 }}>
        <Tabs active={by} onChange={setBy} tabs={[{ id: "product", label: "By product" }, { id: "customer", label: "By customer" }, { id: "month", label: "By month" }]} />
      </div>
      <div className="card-pad" style={{ paddingTop: 0 }}>
        {!data ? <Loading /> : !rows.length ? <Empty title="No sales in this period" /> : (
          <BarList ariaLabel={`Gross margin in pounds ${by === "month" ? "by month" : `by ${by}, highest first`}`}
            rows={rows.map((r) => ({ label: r.label, sub: r.marginPct === null ? undefined : `${r.marginPct}% margin`, value: r.margin,
              detail: <><strong>{r.label}</strong><span>Sales {money(r.revenue)}</span><span>Landed cost {money(r.cost)}</span><span>Margin {money(r.margin)} ({r.marginPct ?? "–"}%)</span>{by === "product" && <small>{qty(r.quantity)} sold</small>}</> }))} />
        )}
      </div>
    </Card>
  );
}

function FxCard() {
  const { data } = useApi<Fx>("/api/analytics/fx-exposure");
  const from = new Date(Date.parse(today()) - 182 * 86_400_000).toISOString().slice(0, 10);
  const { data: history } = useApi<{ date: string; rate: string }[]>(`/api/fx/history?currency=USD&from=${from}&to=${today()}`);
  const usd = data?.currencies.find((c) => c.currency === "USD");
  return (
    <Card title="Currency exposure">
      <div className="card-pad stack" style={{ gap: 14 }}>
        {!data ? <Loading rows={3} /> : !data.currencies.length ? <p className="muted" style={{ margin: 0 }}>No open foreign-currency bills or orders.</p> : data.currencies.map((c) => (
          <div key={c.currency}>
            <dl className="kv">
              <dt>{c.currency} owed and on order</dt><dd>{c.net.toLocaleString("en-GB", { maximumFractionDigits: 0 })} {c.currency}</dd>
              <dt>At today&apos;s rate</dt><dd>{money(c.gbpAtToday)} <span className="muted">(£{c.rateToday.toFixed(4)} per {c.currency})</span></dd>
              <dt>At the rates booked</dt><dd>{money(c.gbpAtBookedRates)}</dd>
              <dt>If sterling moves 5%</dt><dd>± {money(c.fivePercentMove)}</dd>
            </dl>
          </div>
        ))}
        {data && <p className="muted" style={{ margin: 0, fontSize: 13 }}>Realised exchange {data.realisedThisYear >= 0 ? "gains" : "losses"} this year: {money(Math.abs(data.realisedThisYear))}.</p>}
        {history && history.length > 5 && (
          <div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Pounds per US dollar, last six months{usd ? "" : " (reference rate)"}</div>
            <LineChart height={150} zeroLine={false} format={(v) => `£${v.toFixed(3)}`} ariaLabel="GBP per USD, daily reference rate"
              points={history.map((h) => ({ label: shortDate(h.date), value: Number(h.rate) }))} />
          </div>
        )}
      </div>
    </Card>
  );
}

export default function InsightsPage() {
  const { data: k } = useApi<Kpis>("/api/analytics/kpis");
  const { data: anomalies } = useApi<Anomaly[]>("/api/analytics/anomalies");
  const { data: stock } = useApi<{ items: StockItem[]; totals: { value: number; slowValue: number } }>("/api/analytics/stock-health");
  const { data: suppliers } = useApi<Supplier[]>("/api/analytics/suppliers");
  const { data: shipments } = useApi<Shipment[]>("/api/analytics/shipments");

  return (
    <div className="stack">
      <PageHeader title="Insights" subtitle="Margins, cash, currency and stock, worked out from the ledger and stock records as they stand now.">
        <Link className="btn" href="/assistant">Ask a question</Link>
      </PageHeader>
      {k && (
        <div className="strip">
          <div><small>Gross margin, 90 days</small><strong>{k.grossMarginPct ?? "–"}%</strong><em>On {money(k.sales90)} of sales</em></div>
          <div><small>Debtor days</small><strong>{k.debtorDays ?? "–"}</strong><em>How long customers take to pay</em></div>
          <div><small>Creditor days</small><strong>{k.creditorDays ?? "–"}</strong><em>How long you take to pay</em></div>
          <div><small>Stock days</small><strong>{k.stockDays ?? "–"}</strong><em>Turns {k.stockTurn ?? "–"} times a year</em></div>
        </div>
      )}
      <CashForecast />
      <div className="grid-main">
        <Margins />
        <FxCard />
      </div>
      <Card title="Worth checking" actions={anomalies && <span className="muted">{anomalies.length} found</span>}>
        {!anomalies ? <Loading /> : !anomalies.length ? <Empty title="Nothing unusual">Duplicate bills, sales below cost, unusual prices, credit limits, VAT without a supplier VAT number, stale bank lines and uncosted shipments are checked here.</Empty> : (
          <div className="rows">
            {anomalies.map((a, i) => (
              <Link key={i} href={a.href ?? "#"}>
                <span><span className={`sev ${a.severity}`}>{a.severity}</span> {a.title}<small>{a.detail}</small></span>
              </Link>
            ))}
          </div>
        )}
      </Card>
      <Card title="Stock health" actions={stock && <span className="muted">{money(stock.totals.value)} on hand · {money(stock.totals.slowValue)} slow or not selling</span>}>
        <DataTable rows={stock?.items} href={(r) => `/products/${r.id}`} columns={[
          { key: "sku", label: "Product", render: (r) => <span>{r.name}<br /><small className="faint">{r.sku}</small></span> },
          { key: "on", label: "On hand", num: true, render: (r) => qty(r.onHand) },
          { key: "order", label: "On order", num: true, render: (r) => (r.onOrder ? qty(r.onOrder) : "–") },
          { key: "rate", label: "Sells a week", num: true, render: (r) => qty(r.perWeek) },
          { key: "cover", label: "Days' cover", num: true, render: (r) => (r.daysCover === null ? "–" : r.daysCover) },
          { key: "value", label: "Value", num: true, render: (r) => money(r.value) },
          { key: "status", label: "Status", render: (r) => <span className={`pill ${r.status === "reorder" ? "signal" : r.status === "healthy" ? "quiet ok" : ""}`}>{STOCK_STATUS[r.status]}</span> },
        ]} />
      </Card>
      <div className="grid-2">
        <Card title="Suppliers">
          <DataTable rows={suppliers} columns={[
            { key: "n", label: "Supplier", render: (r) => r.name },
            { key: "s", label: "Received", num: true, render: (r) => money(r.spendGbp) },
            { key: "l", label: "Lead time", num: true, render: (r) => (r.averageLeadDays === null ? "–" : `${r.averageLeadDays} days`) },
            { key: "p", label: "Price change", num: true, render: (r) => (r.priceChangePct === null ? "–" : `${r.priceChangePct > 0 ? "+" : ""}${r.priceChangePct}%`) },
          ]} />
        </Card>
        <Card title="Landed cost by shipment">
          <DataTable rows={shipments} href={(r) => `/shipments/${r.id}`} columns={[
            { key: "n", label: "Shipment", render: (r) => <span>{r.number}<br /><small className="faint">{r.reference} · {date(r.date)}</small></span> },
            { key: "g", label: "Goods", num: true, render: (r) => money(r.goods) },
            { key: "c", label: "Freight and duty", num: true, render: (r) => (r.costs ? money(r.costs) : <span className="warn">Not costed</span>) },
            { key: "u", label: "Uplift", num: true, render: (r) => (r.costs ? `${r.upliftPct}%` : "–") },
          ]} />
        </Card>
      </div>
    </div>
  );
}
