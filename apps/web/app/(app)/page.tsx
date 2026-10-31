"use client";

import Link from "next/link";
import { ArtBand, Card, Empty, ErrorBanner, PageHeader, Status } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money, qty, today } from "@/lib/format";

interface Dashboard {
  cash: string; receivables: string; payables: string; stock: string; vatDue: string;
  overdue: { count: number; value: string };
  unreconciled: number;
  lowStock: { id: string; sku: string; name: string; on_hand: string; reorder_level: string }[];
}
interface Doc { due_date: string | null; kind: string; rate: string; outstanding: string }
interface Shipment { id: string; number: string; reference: string | null; date: string; status: string; goods_value: string; costs: string }

const WEEKS = 6;
const DAY = 86400000;

/** Pounds still to come in or go out in each of the next six weeks, by due date. Anything overdue counts in week one. */
function byWeek(docs: Doc[]) {
  const start = Date.parse(today());
  const weeks = Array<number>(WEEKS).fill(0);
  for (const doc of docs) {
    if (!doc.due_date) continue;
    const week = Math.max(0, Math.floor((Date.parse(doc.due_date) - start) / (7 * DAY)));
    if (week < WEEKS) weeks[week]! += Number(doc.outstanding) * Number(doc.rate);
  }
  return weeks;
}

export default function DashboardPage() {
  const { data, error } = useApi<Dashboard>("/api/dashboard");
  const { data: integrity } = useApi<{ allReconciled: boolean }>("/api/reports/integrity");
  const { data: invoices } = useApi<Doc[]>("/api/sales-invoices");
  const { data: bills } = useApi<Doc[]>("/api/supplier-bills");
  const { data: shipments } = useApi<Shipment[]>("/api/shipments");

  const dueIn = byWeek(invoices ?? []);
  const dueOut = byWeek(bills ?? []);
  const totalIn = dueIn.reduce((a, b) => a + b, 0);
  const totalOut = dueOut.reduce((a, b) => a + b, 0);
  let running = Number(data?.cash ?? 0);
  const balances = dueIn.map((amount, i) => (running += amount - dueOut[i]!));
  const top = Math.max(1, ...balances);
  const lowest = Math.min(...balances);
  const ready = Boolean(data && invoices && bills);

  return (
    <div className="stack">
      <div>
        <ArtBand />
        <PageHeader title="Where the business stands today" subtitle={integrity === undefined ? "Checking the ledger…" : integrity.allReconciled ? "Trial balance, stock and goods received all reconcile." : <span className="warn">A sub-ledger doesn&apos;t match its control account. <Link href="/reports?tab=integrity">See details</Link></span>}>
          <Link className="btn" href="/purchase-orders/new">New purchase order</Link>
          <Link className="btn primary" href="/invoices/new">New invoice</Link>
        </PageHeader>
      </div>
      <ErrorBanner message={error} />
      <Card title="Cash, next six weeks">
        <div className="cash">
          <div className="cash-now">
            <span className="muted">Cash at bank today</span>
            <div className="figure">{money(data?.cash)}</div>
            <dl>
              <dt>Due in from customers</dt><dd>{ready ? `+ ${money(totalIn)}` : "…"}</dd>
              <dt>Due out to suppliers</dt><dd>{ready ? `− ${money(totalOut)}` : "…"}</dd>
            </dl>
          </div>
          <div className="cash-weeks" role="img" aria-label={`Projected cash by week from invoice and bill due dates. Lowest ${money(lowest)}.`}>
            {ready && balances.map((b, i) => (
              <div className={`cash-week${b === lowest ? " low" : ""}`} key={i}>
                <b>{money(Math.round(b))}</b>
                <i style={{ height: `${Math.max(2, (Math.max(0, b) / top) * 130)}px` }} />
                {i === 0 ? "This week" : `Week ${i + 1}`}
              </div>
            ))}
          </div>
        </div>
        <p className="muted" style={{ margin: 0, padding: "0 24px 16px", fontSize: 12 }}>Projected from the due dates on unpaid invoices and bills. VAT and other payments are not included.</p>
      </Card>
      <div className="grid-2">
        <Card title="Shipments and landed cost" actions={<Link className="btn small ghost" href="/shipments">All shipments</Link>}>
          {shipments && !shipments.length && <Empty title="No shipments yet">Group goods received into a shipment to land freight and duty.</Empty>}
          <div className="rows">
            {(shipments ?? []).slice(0, 5).map((s) => (
              <Link key={s.id} href={`/shipments/${s.id}`}>
                <span>{s.number}{s.reference ? ` · ${s.reference}` : ""}<small>{date(s.date)} · goods {money(s.goods_value)}</small></span>
                <span className="end"><Status value={s.status} /><small>{Number(s.costs) ? `Costs ${money(s.costs)}` : "No costs landed yet"}</small></span>
              </Link>
            ))}
          </div>
        </Card>
        <Card title="Low stock" actions={<Link className="btn small ghost" href="/products">All products</Link>}>
          {data && !data.lowStock.length && <Empty title="Stock levels look healthy">Products at or below their reorder level show here.</Empty>}
          <div className="rows">
            {data?.lowStock.map((l) => (
              <Link key={l.id} href={`/products/${l.id}`}>
                <span>{l.name}<small>{l.sku}</small></span>
                <span className="end"><span className="warn">{qty(l.on_hand)} left</span><small>Reorder at {qty(l.reorder_level)}</small></span>
              </Link>
            ))}
          </div>
        </Card>
      </div>
      {data && (
        <div className="strip">
          <Link href="/reports?tab=aged-debtors"><small>Owed to you</small><strong>{money(data.receivables)}</strong><em className={data.overdue.count ? "warn" : undefined}>{data.overdue.count ? `${data.overdue.count} overdue · ${money(data.overdue.value)}` : "Nothing overdue"}</em></Link>
          <Link href="/reports?tab=aged-creditors"><small>You owe</small><strong>{money(data.payables)}</strong><em>Trade creditors</em></Link>
          <Link href="/reports?tab=stock"><small>Stock value</small><strong>{money(data.stock)}</strong><em>At landed cost</em></Link>
          <Link href="/vat"><small>VAT position</small><strong>{money(data.vatDue)}</strong><em>{Number(data.vatDue) >= 0 ? "Owed to HMRC" : "Due back from HMRC"}</em></Link>
          <Link href="/banking"><small>Bank lines to reconcile</small><strong>{data.unreconciled}</strong><em className={data.unreconciled ? "warn" : undefined}>{data.unreconciled ? "On the statement" : "Fully reconciled"}</em></Link>
        </div>
      )}
    </div>
  );
}
