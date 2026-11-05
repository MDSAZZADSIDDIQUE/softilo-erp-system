import type { Sql } from "@softilo/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inTenant } from "../lib/context.js";
import { fxRate } from "../lib/connections.js";
import { addDays, isoDate, today } from "../lib/schemas.js";

type Providers = FastifyInstance["providers"];
const n = (v: unknown) => Number(v ?? 0);
const r2 = (v: number) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------- margin

/** Sales lines in GBP with credit notes netted off; cost is landed cost at the time the goods left. */
const SALES_LINES = `
  SELECT l.*, i.date, i.customer_id, i.kind,
         CASE WHEN i.kind = 'credit' THEN -1 ELSE 1 END * round(l.net * i.rate, 2) AS revenue,
         CASE WHEN i.kind = 'credit' THEN -1 ELSE 1 END * l.cost_gbp AS cost,
         CASE WHEN i.kind = 'credit' THEN -1 ELSE 1 END * l.quantity AS qty
    FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.invoice_id
   WHERE i.date BETWEEN $1 AND $2`;

export async function margin(tx: Sql, q: { from: string; to: string; by: "product" | "customer" | "month" }) {
  const key = { product: "coalesce(p.sku, 'Non-stock')", customer: "c.name", month: "to_char(s.date, 'YYYY-MM')" }[q.by];
  const label = { product: "coalesce(p.name, 'Services and other')", customer: "c.name", month: "to_char(s.date, 'Mon YYYY')" }[q.by];
  const rows = await tx.query<{ key: string; label: string; revenue: string; cost: string; qty: string; invoices: string }>(
    `SELECT ${key} AS key, min(${label}) AS label, sum(s.revenue) AS revenue, sum(s.cost) AS cost, sum(s.qty) AS qty,
            count(DISTINCT s.invoice_id) AS invoices
       FROM (${SALES_LINES}) s LEFT JOIN products p ON p.id = s.product_id JOIN contacts c ON c.id = s.customer_id
      GROUP BY 1 ORDER BY ${q.by === "month" ? "1" : "sum(s.revenue - s.cost) DESC"}`, [q.from, q.to]);
  const out = rows.map((r) => {
    const revenue = n(r.revenue);
    const cost = n(r.cost);
    return { key: r.key, label: r.label, revenue: r2(revenue), cost: r2(cost), margin: r2(revenue - cost),
      marginPct: revenue ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null, quantity: n(r.qty), invoices: n(r.invoices) };
  });
  const revenue = out.reduce((s, r) => s + r.revenue, 0);
  const cost = out.reduce((s, r) => s + r.cost, 0);
  return { ...q, rows: out, totals: { revenue: r2(revenue), cost: r2(cost), margin: r2(revenue - cost), marginPct: revenue ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null } };
}

// ---------------------------------------------------------------- cash forecast

interface Flow { date: string; amount: number; kind: string; label: string; ref?: string; href?: string }

/**
 * Thirteen weeks of cash, the standard UK treasury view: what customers owe (moved by how late each one
 * usually pays), bills due, approved purchase orders that will be billed, VAT due to HMRC, and the regular
 * outgoings that never go through a bill (payroll, direct debits), projected from the last three months.
 */
export async function cashForecast(tx: Sql, weeks = 13) {
  const start = today();
  const end = addDays(start, weeks * 7 - 1);
  const [bank] = await tx.query<{ v: string }>("SELECT coalesce(sum(debit - credit), 0) AS v FROM journal_lines l JOIN accounts a ON a.code = l.account_code WHERE a.is_bank");
  const flows: Flow[] = [];

  const lateness = await tx.query<{ customer_id: string; days: string }>(
    `SELECT i.customer_id, round(avg(greatest(p.date - i.due_date, 0)))::text AS days
       FROM payment_allocations a JOIN payments p ON p.id = a.payment_id JOIN sales_invoices i ON i.id = a.document_id
      WHERE a.document_type = 'sales_invoice' GROUP BY i.customer_id`);
  const late = new Map(lateness.map((l) => [l.customer_id, n(l.days)]));
  const invoices = await tx.query<{ id: string; number: string; customer_id: string; name: string; due_date: string; gbp: string }>(
    `SELECT i.id, i.number, i.customer_id, c.name, i.due_date::text, round((i.total - i.amount_paid) * i.rate, 2) AS gbp
       FROM sales_invoices i JOIN contacts c ON c.id = i.customer_id WHERE i.kind = 'invoice' AND i.amount_paid < i.total`);
  for (const i of invoices) {
    let date = addDays(i.due_date, late.get(i.customer_id) ?? 0);
    if (date < start) date = addDays(start, 3); // overdue: assume it comes in this week once chased
    flows.push({ date, amount: n(i.gbp), kind: "customers", label: `${i.name} ${i.number}`, ref: i.number, href: `/invoices/${i.id}` });
  }
  const credits = await tx.query<{ gbp: string }>("SELECT coalesce(sum(round((total - amount_paid) * rate, 2)), 0) AS gbp FROM sales_invoices WHERE kind = 'credit' AND amount_paid < total");
  if (n(credits[0]?.gbp)) flows.push({ date: addDays(start, 7), amount: -n(credits[0]!.gbp), kind: "customers", label: "Unapplied customer credit notes" });

  const bills = await tx.query<{ id: string; number: string; name: string; due_date: string; gbp: string; kind: string }>(
    `SELECT b.id, b.number, c.name, b.due_date::text, round((b.total - b.amount_paid) * b.rate, 2) AS gbp, b.kind
       FROM supplier_bills b JOIN contacts c ON c.id = b.supplier_id WHERE b.amount_paid < b.total`);
  for (const b of bills) {
    const date = b.due_date < start ? start : b.due_date;
    flows.push({ date, amount: (b.kind === "credit" ? 1 : -1) * n(b.gbp), kind: "suppliers", label: `${b.name} ${b.number}`, ref: b.number, href: `/bills/${b.id}` });
  }

  const pos = await tx.query<{ id: string; number: string; name: string; date: string; expected_date: string | null; terms: number; gbp: string }>(
    `SELECT o.id, o.number, c.name, o.date::text, o.expected_date::text, c.payment_terms_days AS terms,
            round(sum((l.quantity - l.received_qty) * l.unit_price) * o.rate, 2) AS gbp
       FROM purchase_orders o JOIN purchase_order_lines l ON l.po_id = o.id JOIN contacts c ON c.id = o.supplier_id
      WHERE o.status IN ('approved','part_received') GROUP BY o.id, c.name, c.payment_terms_days HAVING sum(l.quantity - l.received_qty) > 0`);
  for (const p of pos) {
    // Goods typically land five weeks after ordering from Asia; the supplier is paid on its terms after that.
    const arrival = p.expected_date ?? addDays(p.date, 35);
    flows.push({ date: addDays(arrival < start ? start : arrival, p.terms), amount: -n(p.gbp), kind: "orders", label: `${p.name} ${p.number} (on order)`, ref: p.number, href: `/purchase-orders/${p.id}` });
  }

  // VAT on the current open period, due one month and seven days after the quarter ends.
  const [vat] = await tx.query<{ out: string; inp: string; last_end: string | null }>(
    `SELECT coalesce(sum(vat) FILTER (WHERE direction = 'sales'), 0) + coalesce(sum(vat) FILTER (WHERE direction = 'purchase' AND vat_code IN ('RC20','PVA20')), 0) AS out,
            coalesce(sum(vat) FILTER (WHERE direction = 'purchase'), 0) AS inp,
            (SELECT max(end_date)::text FROM vat_returns) AS last_end
       FROM vat_entries WHERE vat_return_id IS NULL`);
  const [vatLiab] = await tx.query<{ v: string }>("SELECT coalesce(sum(credit - debit), 0) AS v FROM journal_lines l JOIN accounts a ON a.code = l.account_code WHERE a.role = 'vat_control'");
  const addMonths = (date: string, months: number) => {
    const x = new Date(`${date}T00:00:00Z`);
    x.setUTCMonth(x.getUTCMonth() + months);
    return x.toISOString().slice(0, 10);
  };
  const due = (endDate: string) => addDays(addMonths(addDays(endDate, 1), 1), 6);
  if (vat?.last_end) {
    // A finalised return not yet paid (VAT liability account still in credit).
    if (n(vatLiab?.v) > 0) flows.push({ date: due(vat.last_end) < start ? start : due(vat.last_end), amount: -n(vatLiab!.v), kind: "vat", label: "VAT return already finalised", href: "/vat" });
    const nextEnd = addDays(addMonths(addDays(vat.last_end, 1), 3), -1);
    const owed = n(vat.out) - n(vat.inp);
    if (owed > 0) flows.push({ date: due(nextEnd), amount: -r2(owed), kind: "vat", label: `VAT for the quarter to ${nextEnd} (so far)`, href: "/vat" });
  }

  // Regular outgoings straight from the bank: payroll and other manual or bank-coded postings, monthly average.
  const regular = await tx.query<{ memo: string; dom: string; avg: string }>(
    `SELECT regexp_replace(e.memo, '\\s*\\d{2}/\\d{4}.*$', '') AS memo, round(avg(extract(day FROM e.date)))::text AS dom,
            round(sum(l.credit - l.debit) / 3, 2)::text AS avg
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.code = l.account_code
      WHERE a.is_bank AND e.source_type IN ('manual','bank_transaction') AND e.date >= current_date - 92
        AND l.credit > 0 AND e.memo NOT ILIKE '%capital%'
      GROUP BY 1 HAVING count(*) >= 2 ORDER BY 3 DESC`);
  for (const rg of regular) {
    for (let m = 0; m < 4; m++) {
      const x = new Date(`${start.slice(0, 8)}01T00:00:00Z`);
      x.setUTCMonth(x.getUTCMonth() + m);
      x.setUTCDate(Math.min(n(rg.dom), 28));
      const date = x.toISOString().slice(0, 10);
      if (date >= start && date <= end) flows.push({ date, amount: -n(rg.avg), kind: "regular", label: `${rg.memo} (average of last 3 months)` });
    }
  }

  let balance = n(bank!.v);
  const opening = balance;
  const series = Array.from({ length: weeks }, (_, w) => {
    const from = addDays(start, w * 7);
    const to = addDays(from, 6);
    const items = flows.filter((f) => f.date >= from && f.date <= to);
    const inflow = items.filter((f) => f.amount > 0).reduce((s, f) => s + f.amount, 0);
    const outflow = items.filter((f) => f.amount < 0).reduce((s, f) => s - f.amount, 0);
    balance += inflow - outflow;
    const byKind: Record<string, number> = {};
    for (const f of items) byKind[f.kind] = r2((byKind[f.kind] ?? 0) + f.amount);
    return { week: w + 1, from, to, inflow: r2(inflow), outflow: r2(outflow), net: r2(inflow - outflow), closing: r2(balance), byKind, items: items.sort((a, b) => a.amount - b.amount) };
  });
  const low = series.reduce((m, s) => (s.closing < m.closing ? s : m), series[0]!);
  return { from: start, to: end, opening: r2(opening), closing: r2(balance), lowest: { week: low.week, from: low.from, closing: low.closing }, weeks: series };
}

// ---------------------------------------------------------------- FX exposure

export async function fxExposure(tx: Sql, providers: Providers) {
  const rows = await tx.query<{ currency: string; kind: string; amount: string; booked_gbp: string }>(
    `SELECT currency, 'bills' AS kind, sum(CASE WHEN kind = 'bill' THEN 1 ELSE -1 END * (total - amount_paid)) AS amount,
            sum(CASE WHEN kind = 'bill' THEN 1 ELSE -1 END * round((total - amount_paid) * rate, 2)) AS booked_gbp
       FROM supplier_bills WHERE currency <> 'GBP' AND amount_paid < total GROUP BY currency
     UNION ALL
     SELECT o.currency, 'orders', sum((l.quantity - l.received_qty) * l.unit_price), sum(round((l.quantity - l.received_qty) * l.unit_price * o.rate, 2))
       FROM purchase_orders o JOIN purchase_order_lines l ON l.po_id = o.id
      WHERE o.currency <> 'GBP' AND o.status IN ('draft','approved','part_received') GROUP BY o.currency
     UNION ALL
     SELECT currency, 'receivables', -sum(CASE WHEN kind = 'invoice' THEN 1 ELSE -1 END * (total - amount_paid)), -sum(CASE WHEN kind = 'invoice' THEN 1 ELSE -1 END * round((total - amount_paid) * rate, 2))
       FROM sales_invoices WHERE currency <> 'GBP' AND amount_paid < total GROUP BY currency`);
  const currencies = [...new Set(rows.map((r) => r.currency))];
  const out = [];
  for (const cur of currencies) {
    const rate = n((await fxRate(tx, providers, cur, today()))?.rate);
    const of = (k: string) => rows.filter((r) => r.currency === cur && r.kind === k);
    const sumOf = (k: string, f: "amount" | "booked_gbp") => of(k).reduce((s, r) => s + n(r[f]), 0);
    const net = sumOf("bills", "amount") + sumOf("orders", "amount") + sumOf("receivables", "amount");
    const booked = sumOf("bills", "booked_gbp") + sumOf("orders", "booked_gbp") + sumOf("receivables", "booked_gbp");
    const atToday = net * rate;
    out.push({
      currency: cur, rateToday: rate, payable: r2(sumOf("bills", "amount")), onOrder: r2(sumOf("orders", "amount")), receivable: r2(-sumOf("receivables", "amount")),
      net: r2(net), gbpAtBookedRates: r2(booked), gbpAtToday: r2(atToday),
      // Positive means sterling has weakened since booking: the same dollars now cost more pounds.
      unrealised: r2(atToday - booked), fivePercentMove: r2(Math.abs(atToday) * 0.05),
    });
  }
  const [realised] = await tx.query<{ v: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0) AS v FROM journal_lines l JOIN accounts a ON a.code = l.account_code JOIN journal_entries e ON e.id = l.entry_id
      WHERE a.role = 'fx' AND e.date >= date_trunc('year', current_date)`);
  return { asAt: today(), currencies: out, realisedThisYear: r2(-n(realised!.v)) };
}

// ---------------------------------------------------------------- stock

export async function stockHealth(tx: Sql) {
  const rows = await tx.query<{ id: string; sku: string; name: string; on_hand: string; value: string; reorder_level: string | null;
    sold_90: string; last_sold: string | null; on_order: string; first_in: string | null }>(
    `SELECT p.id, p.sku, p.name, p.reorder_level::text,
            coalesce(sum(b.quantity), 0) AS on_hand, coalesce(sum(b.value), 0) AS value,
            (SELECT coalesce(-sum(quantity), 0) FROM stock_movements m WHERE m.product_id = p.id AND m.kind = 'issue' AND m.date > current_date - 90) AS sold_90,
            (SELECT max(date)::text FROM stock_movements m WHERE m.product_id = p.id AND m.kind = 'issue') AS last_sold,
            (SELECT min(date)::text FROM stock_movements m WHERE m.product_id = p.id AND m.kind = 'receipt') AS first_in,
            (SELECT coalesce(sum(l.quantity - l.received_qty), 0) FROM purchase_order_lines l JOIN purchase_orders o ON o.id = l.po_id
              WHERE l.product_id = p.id AND o.status IN ('approved','part_received')) AS on_order
       FROM products p LEFT JOIN stock_balances b ON b.product_id = p.id
      WHERE p.track_stock AND NOT p.archived GROUP BY p.id ORDER BY p.sku`);
  const items = rows.map((r) => {
    // Products stocked for under 90 days are judged on the days they have been in stock.
    const days = r.first_in ? Math.min(90, Math.max(1, (Date.parse(today()) - Date.parse(r.first_in)) / 86_400_000)) : 90;
    const perDay = n(r.sold_90) / days;
    const cover = perDay > 0 ? Math.round(n(r.on_hand) / perDay) : null;
    const reorderAt = r.reorder_level === null ? null : n(r.reorder_level);
    const status = reorderAt !== null && n(r.on_hand) + n(r.on_order) <= reorderAt ? "reorder"
      : n(r.on_hand) > 0 && perDay === 0 ? "dead"
      : cover !== null && cover > 150 ? "slow" : "healthy";
    return { id: r.id, sku: r.sku, name: r.name, onHand: n(r.on_hand), value: r2(n(r.value)), averageCost: n(r.on_hand) ? r2(n(r.value) / n(r.on_hand)) : 0,
      soldLast90: n(r.sold_90), perWeek: Math.round(perDay * 7 * 10) / 10, daysCover: cover, onOrder: n(r.on_order), reorderLevel: reorderAt,
      lastSold: r.last_sold, status };
  });
  const value = items.reduce((s, i) => s + i.value, 0);
  return { asAt: today(), items, totals: { value: r2(value), reorder: items.filter((i) => i.status === "reorder").length, slow: items.filter((i) => i.status === "slow").length,
    dead: items.filter((i) => i.status === "dead").length, slowValue: r2(items.filter((i) => i.status !== "healthy" && i.status !== "reorder").reduce((s, i) => s + i.value, 0)) } };
}

// ---------------------------------------------------------------- suppliers and shipments

export async function supplierPerformance(tx: Sql) {
  const rows = await tx.query<{ id: string; name: string; currency: string; orders: string; spend: string; lead: string | null; on_time: string | null; with_expected: string; ppv: string; first_price: string | null; last_price: string | null }>(
    `SELECT c.id, c.name, c.currency, count(DISTINCT o.id) AS orders,
            coalesce((SELECT sum(gl.value_gbp) FROM goods_receipt_lines gl JOIN goods_receipts r ON r.id = gl.receipt_id JOIN purchase_orders x ON x.id = r.po_id WHERE x.supplier_id = c.id), 0) AS spend,
            (SELECT round(avg(fr.first - x.date), 1) FROM purchase_orders x JOIN LATERAL (SELECT min(date) AS first FROM goods_receipts r WHERE r.po_id = x.id) fr ON fr.first IS NOT NULL WHERE x.supplier_id = c.id)::text AS lead,
            (SELECT count(*) FILTER (WHERE fr.first <= x.expected_date) FROM purchase_orders x JOIN LATERAL (SELECT min(date) AS first FROM goods_receipts r WHERE r.po_id = x.id) fr ON fr.first IS NOT NULL WHERE x.supplier_id = c.id AND x.expected_date IS NOT NULL)::text AS on_time,
            (SELECT count(*) FROM purchase_orders x WHERE x.supplier_id = c.id AND x.expected_date IS NOT NULL AND x.status IN ('part_received','received'))::text AS with_expected,
            coalesce((SELECT sum(l.debit - l.credit) FROM supplier_bills b JOIN journal_lines l ON l.entry_id = b.entry_id JOIN accounts a ON a.code = l.account_code WHERE b.supplier_id = c.id AND a.role = 'ppv'), 0) AS ppv,
            (SELECT avg(first_price) FROM (SELECT DISTINCT ON (l.product_id) l.unit_price AS first_price FROM purchase_order_lines l JOIN purchase_orders x ON x.id = l.po_id WHERE x.supplier_id = c.id AND x.status <> 'cancelled' ORDER BY l.product_id, x.date) f)::text AS first_price,
            (SELECT avg(last_price) FROM (SELECT DISTINCT ON (l.product_id) l.unit_price AS last_price FROM purchase_order_lines l JOIN purchase_orders x ON x.id = l.po_id WHERE x.supplier_id = c.id AND x.status <> 'cancelled' ORDER BY l.product_id, x.date DESC) f)::text AS last_price
       FROM contacts c JOIN purchase_orders o ON o.supplier_id = c.id AND o.status <> 'cancelled'
      GROUP BY c.id ORDER BY 5 DESC`);
  return rows.map((r) => ({
    id: r.id, name: r.name, currency: r.currency, orders: n(r.orders), spendGbp: r2(n(r.spend)), averageLeadDays: r.lead === null ? null : n(r.lead),
    onTimePct: n(r.with_expected) ? Math.round((n(r.on_time) / n(r.with_expected)) * 100) : null,
    priceVarianceGbp: r2(n(r.ppv)), priceChangePct: r.first_price && n(r.first_price) ? Math.round(((n(r.last_price) - n(r.first_price)) / n(r.first_price)) * 1000) / 10 : null,
  }));
}

export async function landedCostByShipment(tx: Sql) {
  const rows = await tx.query<{ id: string; number: string; reference: string | null; date: string; status: string; goods: string; costs: string; kg: string; units: string }>(
    `SELECT s.id, s.number, s.reference, s.date::text, s.status,
            coalesce((SELECT sum(value_gbp) FROM goods_receipt_lines g WHERE g.shipment_id = s.id), 0) AS goods,
            coalesce((SELECT sum(amount_gbp) FROM shipment_costs c WHERE c.shipment_id = s.id), 0) AS costs,
            coalesce((SELECT sum(g.quantity * coalesce(p.weight_kg, 0)) FROM goods_receipt_lines g JOIN products p ON p.id = g.product_id WHERE g.shipment_id = s.id), 0) AS kg,
            coalesce((SELECT sum(g.quantity) FROM goods_receipt_lines g WHERE g.shipment_id = s.id), 0) AS units
       FROM shipments s ORDER BY s.date`);
  return rows.map((r) => ({ id: r.id, number: r.number, reference: r.reference, date: r.date, status: r.status, goods: r2(n(r.goods)), costs: r2(n(r.costs)),
    upliftPct: n(r.goods) ? Math.round((n(r.costs) / n(r.goods)) * 1000) / 10 : 0, costPerKg: n(r.kg) ? r2(n(r.costs) / n(r.kg)) : null,
    costPerUnit: n(r.units) ? r2(n(r.costs) / n(r.units)) : null }));
}

// ---------------------------------------------------------------- KPIs and anomalies

export async function kpis(tx: Sql) {
  const [k] = await tx.query<Record<string, string>>(
    `SELECT
       (SELECT coalesce(sum(debit - credit), 0) FROM journal_lines l JOIN accounts a ON a.code = l.account_code WHERE a.role = 'debtors') AS debtors,
       (SELECT coalesce(sum(credit - debit), 0) FROM journal_lines l JOIN accounts a ON a.code = l.account_code WHERE a.role = 'creditors') AS creditors,
       (SELECT coalesce(sum(debit - credit), 0) FROM journal_lines l JOIN accounts a ON a.code = l.account_code WHERE a.role = 'stock') AS stock,
       (SELECT coalesce(sum(l.credit - l.debit), 0) FROM journal_lines l JOIN accounts a ON a.code = l.account_code JOIN journal_entries e ON e.id = l.entry_id WHERE a.type = 'income' AND e.date > current_date - 90) AS sales_90,
       (SELECT coalesce(sum(l.debit - l.credit), 0) FROM journal_lines l JOIN accounts a ON a.code = l.account_code JOIN journal_entries e ON e.id = l.entry_id WHERE a.role IN ('cogs','ppv') AND e.date > current_date - 90) AS cogs_90,
       (SELECT coalesce(sum(l.credit - l.debit), 0) FROM journal_lines l JOIN accounts a ON a.code = l.account_code JOIN journal_entries e ON e.id = l.entry_id WHERE a.role = 'creditors' AND e.source_type = 'supplier_bill' AND e.date > current_date - 90) AS purchases_90`);
  const sales = n(k!.sales_90);
  const cogs = n(k!.cogs_90);
  return {
    // Debtor days (DSO) and creditor days (DPO) on the last 90 days' activity; stock turn annualised.
    // Debtors include VAT and sales do not, so sales are grossed up at the standard rate.
    debtorDays: sales ? Math.round((n(k!.debtors) / (sales * 1.2)) * 90) : null,
    creditorDays: n(k!.purchases_90) ? Math.round((n(k!.creditors) / n(k!.purchases_90)) * 90) : null,
    stockDays: cogs ? Math.round((n(k!.stock) / cogs) * 90) : null,
    stockTurn: n(k!.stock) ? Math.round(((cogs * 4) / n(k!.stock)) * 10) / 10 : null,
    grossMarginPct: sales ? Math.round(((sales - cogs) / sales) * 1000) / 10 : null,
    sales90: r2(sales),
  };
}

export interface Anomaly { severity: "high" | "medium" | "low"; kind: string; title: string; detail: string; href?: string }

/** Checks a careful bookkeeper would run at month end. Each finding links to the record to look at. */
export async function anomalies(tx: Sql): Promise<Anomaly[]> {
  const out: Anomaly[] = [];
  const money = (v: unknown) => `£${n(v).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  for (const r of await tx.query<{ a: string; an: string; b: string; bn: string; name: string; total: string; currency: string; ar: string; br: string }>(
    `SELECT x.id AS a, x.number AS an, y.id AS b, y.number AS bn, c.name, x.total, x.currency, x.supplier_ref AS ar, y.supplier_ref AS br
       FROM supplier_bills x JOIN supplier_bills y ON y.supplier_id = x.supplier_id AND y.total = x.total AND y.id > x.id AND abs(y.date - x.date) <= 10
       JOIN contacts c ON c.id = x.supplier_id WHERE x.kind = 'bill' AND y.kind = 'bill'`)) {
    out.push({ severity: "high", kind: "duplicate_bill", title: `Possible duplicate bill from ${r.name}`,
      detail: `${r.an} (${r.ar}) and ${r.bn} (${r.br}) are both for ${r.total} ${r.currency} within ten days.`, href: `/bills/${r.b}` });
  }
  for (const r of await tx.query<{ id: string; number: string; name: string; description: string; net: string; cost: string }>(
    `SELECT i.id, i.number, c.name, l.description, round(l.net * i.rate, 2) AS net, l.cost_gbp AS cost FROM sales_invoice_lines l
       JOIN sales_invoices i ON i.id = l.invoice_id JOIN contacts c ON c.id = i.customer_id
      WHERE i.kind = 'invoice' AND l.cost_gbp > 0 AND round(l.net * i.rate, 2) < l.cost_gbp ORDER BY i.date DESC LIMIT 10`)) {
    out.push({ severity: "medium", kind: "below_cost", title: `Sold below landed cost on ${r.number}`,
      detail: `${r.description} to ${r.name}: sold for ${money(r.net)}, cost ${money(r.cost)}.`, href: `/invoices/${r.id}` });
  }
  for (const r of await tx.query<{ id: string; number: string; name: string; description: string; price: string; median: string }>(
    `WITH lines AS (SELECT l.product_id, l.unit_price * i.rate AS price, i.id, i.number, i.customer_id, l.description FROM sales_invoice_lines l
                      JOIN sales_invoices i ON i.id = l.invoice_id WHERE i.kind = 'invoice' AND l.product_id IS NOT NULL),
          med AS (SELECT product_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY price) AS median, count(*) AS n FROM lines GROUP BY product_id)
     SELECT l.id, l.number, c.name, l.description, round(l.price, 2)::text AS price, round(m.median::numeric, 2)::text AS median
       FROM lines l JOIN med m ON m.product_id = l.product_id JOIN contacts c ON c.id = l.customer_id
      WHERE m.n >= 4 AND abs(l.price - m.median) / nullif(m.median, 0) > 0.15 LIMIT 10`)) {
    out.push({ severity: "low", kind: "unusual_price", title: `Unusual price on ${r.number}`,
      detail: `${r.description} to ${r.name} at £${r.price} each; the usual price is £${r.median}.`, href: `/invoices/${r.id}` });
  }
  for (const r of await tx.query<{ id: string; name: string; owed: string; credit_limit: string }>(
    `SELECT c.id, c.name, c.credit_limit, sum(round((i.total - i.amount_paid) * i.rate, 2) * CASE WHEN i.kind = 'invoice' THEN 1 ELSE -1 END) AS owed
       FROM contacts c JOIN sales_invoices i ON i.customer_id = c.id WHERE c.credit_limit IS NOT NULL
      GROUP BY c.id HAVING sum(round((i.total - i.amount_paid) * i.rate, 2) * CASE WHEN i.kind = 'invoice' THEN 1 ELSE -1 END) > c.credit_limit`)) {
    out.push({ severity: "high", kind: "credit_limit", title: `${r.name} is over its credit limit`,
      detail: `Owes ${money(r.owed)} against a limit of ${money(r.credit_limit)}. Consider holding new orders.`, href: `/contacts/${r.id}` });
  }
  for (const r of await tx.query<{ id: string; number: string; name: string; vat: string }>(
    `SELECT b.id, b.number, c.name, sum(l.vat) AS vat FROM supplier_bills b JOIN contacts c ON c.id = b.supplier_id JOIN supplier_bill_lines l ON l.bill_id = b.id
      WHERE c.vat_number IS NULL AND b.currency = 'GBP' AND l.vat_code IN ('S20','R5') GROUP BY b.id, c.name HAVING sum(l.vat) > 0`)) {
    out.push({ severity: "medium", kind: "vat_no_number", title: `VAT reclaimed without a supplier VAT number`,
      detail: `${r.number} from ${r.name} reclaims ${money(r.vat)} of VAT, but no VAT number is held. HMRC can refuse the claim.`, href: `/bills/${r.id}` });
  }
  for (const r of await tx.query<{ n: string; v: string; oldest: string }>(
    "SELECT count(*) AS n, coalesce(sum(abs(amount)), 0) AS v, min(date)::text AS oldest FROM bank_transactions WHERE status = 'unreconciled' AND date < current_date - 21")) {
    if (n(r.n)) out.push({ severity: "medium", kind: "stale_bank", title: `${r.n} bank lines unreconciled for over three weeks`,
      detail: `${money(r.v)} in total, the oldest from ${r.oldest}. Late reconciliation hides errors and delays the VAT return.`, href: "/banking" });
  }
  for (const r of await tx.query<{ id: string; number: string; name: string; days: string }>(
    `SELECT s.id, s.number, coalesce(s.reference, '') AS name, (current_date - s.date)::text AS days FROM shipments s
      WHERE s.status = 'open' AND s.date < current_date - 7`)) {
    out.push({ severity: "low", kind: "uncosted_shipment", title: `Shipment ${r.number} not costed after ${r.days} days`,
      detail: `${r.name ? `${r.name}: ` : ""}until freight and duty are landed, stock and margins on these goods are understated.`, href: `/shipments/${r.id}` });
  }
  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

export async function registerAnalytics(app: FastifyInstance) {
  const Range = z.object({ from: isoDate.optional(), to: isoDate.optional() });
  const range = (q: z.infer<typeof Range>) => ({ from: q.from ?? addDays(today(), -180), to: q.to ?? today() });

  app.get("/api/analytics/margin", (req) => inTenant(req, (tx) => {
    const q = Range.extend({ by: z.enum(["product", "customer", "month"]).default("product") }).parse(req.query);
    return margin(tx, { ...range(q), by: q.by });
  }));
  app.get("/api/analytics/cash-forecast", (req) => inTenant(req, (tx) => {
    const { weeks } = z.object({ weeks: z.coerce.number().int().min(4).max(26).default(13) }).parse(req.query);
    return cashForecast(tx, weeks);
  }));
  app.get("/api/analytics/fx-exposure", (req) => inTenant(req, (tx) => fxExposure(tx, app.providers)));
  app.get("/api/analytics/stock-health", (req) => inTenant(req, (tx) => stockHealth(tx)));
  app.get("/api/analytics/suppliers", (req) => inTenant(req, (tx) => supplierPerformance(tx)));
  app.get("/api/analytics/shipments", (req) => inTenant(req, (tx) => landedCostByShipment(tx)));
  app.get("/api/analytics/kpis", (req) => inTenant(req, (tx) => kpis(tx)));
  app.get("/api/analytics/anomalies", (req) => inTenant(req, (tx) => anomalies(tx)));
}
