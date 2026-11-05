import { newId, type Sql } from "@softilo/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AssistantTool } from "../integrations/index.js";
import { inTenant } from "../lib/context.js";
import { addDays, today } from "../lib/schemas.js";
import { anomalies, cashForecast, fxExposure, kpis, landedCostByShipment, margin, stockHealth, supplierPerformance } from "./analytics.js";

type Providers = FastifyInstance["providers"];
const gbp = (v: number) => `£${Math.round(v).toLocaleString("en-GB")}`;
const dateArgs = {
  type: "object",
  properties: { from: { type: "string", description: "Start date YYYY-MM-DD (default: six months ago)" }, to: { type: "string", description: "End date YYYY-MM-DD (default: today)" } },
};
const str = (v: unknown, fallback: string) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fallback);

/** Read-only tools over the company's books. The assistant can look but never post, pay or send. */
export function assistantTools(tx: Sql, providers: Providers): AssistantTool[] {
  return [
    {
      name: "margin_by_product", keywords: /margin|profit|best|worst|product|sku|range|selling/i,
      description: "Sales, landed cost and gross margin by product (SKU) for a date range",
      parameters: dateArgs,
      run: (a) => margin(tx, { from: str(a.from, addDays(today(), -180)), to: str(a.to, today()), by: "product" }),
      summarise: (r) => {
        const m = r as Awaited<ReturnType<typeof margin>>;
        const rows = m.rows.filter((x) => x.revenue > 0);
        if (!rows.length) return "No sales in that period.";
        const best = [...rows].sort((a, b) => (b.marginPct ?? 0) - (a.marginPct ?? 0));
        return `Gross margin over the last six months is ${m.totals.marginPct}% on ${gbp(m.totals.revenue)} of sales. `
          + `The strongest product by margin is ${best[0]!.label} (${best[0]!.marginPct}%), and the weakest is ${best.at(-1)!.label} (${best.at(-1)!.marginPct}%). `
          + `${rows[0]!.label} brings in the most profit: ${gbp(rows[0]!.margin)}.`;
      },
    },
    {
      name: "margin_by_customer", keywords: /customer|client|account|who buys|biggest buyer/i,
      description: "Sales, cost and gross margin by customer for a date range",
      parameters: dateArgs,
      run: (a) => margin(tx, { from: str(a.from, addDays(today(), -180)), to: str(a.to, today()), by: "customer" }),
      summarise: (r) => {
        const m = r as Awaited<ReturnType<typeof margin>>;
        if (!m.rows.length) return "No sales in that period.";
        const top = [...m.rows].sort((a, b) => b.revenue - a.revenue);
        return `${top[0]!.label} is your largest customer at ${gbp(top[0]!.revenue)} (${top[0]!.marginPct}% margin). `
          + `Across ${m.rows.length} customers, margins range from ${Math.min(...m.rows.map((x) => x.marginPct ?? 0))}% to ${Math.max(...m.rows.map((x) => x.marginPct ?? 0))}%.`;
      },
    },
    {
      name: "cash_forecast", keywords: /cash|forecast|bank balance|tight|runway|afford|money/i,
      description: "13-week cash forecast: opening bank balance, expected receipts, bills, purchase orders, VAT and payroll, week by week",
      parameters: { type: "object", properties: {} },
      run: () => cashForecast(tx, 13),
      summarise: (r) => {
        const c = r as Awaited<ReturnType<typeof cashForecast>>;
        const worst = [...c.weeks].sort((a, b) => a.net - b.net)[0]!;
        return `Cash at bank is ${gbp(c.opening)} and is forecast at ${gbp(c.closing)} in 13 weeks. `
          + `The low point is ${gbp(c.lowest.closing)} in week ${c.lowest.week} (from ${c.lowest.from}). `
          + `The heaviest week is week ${worst.week}, with ${gbp(worst.outflow)} going out, mainly ${worst.items.filter((i) => i.amount < 0).slice(0, 2).map((i) => i.label).join(" and ")}.`;
      },
    },
    {
      name: "aged_debtors", keywords: /overdue|owe us|debtor|chase|late pay|outstanding|unpaid/i,
      description: "Unpaid customer invoices: who owes what and how overdue",
      parameters: { type: "object", properties: {} },
      run: () => tx.query(
        `SELECT c.name, i.number, i.due_date::text, (current_date - i.due_date) AS days_overdue, round((i.total - i.amount_paid) * i.rate, 2)::text AS outstanding_gbp
           FROM sales_invoices i JOIN contacts c ON c.id = i.customer_id WHERE i.kind = 'invoice' AND i.amount_paid < i.total ORDER BY i.due_date`),
      summarise: (r) => {
        const rows = r as { name: string; number: string; days_overdue: number; outstanding_gbp: string }[];
        const late = rows.filter((x) => x.days_overdue > 0);
        const total = rows.reduce((s, x) => s + Number(x.outstanding_gbp), 0);
        if (!late.length) return `Customers owe ${gbp(total)} and nothing is overdue.`;
        const lateTotal = late.reduce((s, x) => s + Number(x.outstanding_gbp), 0);
        return `Customers owe ${gbp(total)}, of which ${gbp(lateTotal)} is overdue on ${late.length} invoice${late.length === 1 ? "" : "s"}. `
          + `The oldest is ${late[0]!.number} from ${late[0]!.name}, ${late[0]!.days_overdue} days late (${gbp(Number(late[0]!.outstanding_gbp))}).`;
      },
    },
    {
      name: "stock_health", keywords: /stock|inventory|reorder|dead|slow|cover|run out|warehouse/i,
      description: "Stock on hand by product with weekly sales rate, days of cover, items on order and status (reorder, slow, dead, healthy)",
      parameters: { type: "object", properties: {} },
      run: () => stockHealth(tx),
      summarise: (r) => {
        const s = r as Awaited<ReturnType<typeof stockHealth>>;
        const reorder = s.items.filter((i) => i.status === "reorder");
        const slow = s.items.filter((i) => i.status === "slow" || i.status === "dead");
        return `Stock is worth ${gbp(s.totals.value)} at landed cost. `
          + (reorder.length ? `${reorder.map((i) => `${i.name} (${i.onHand} left)`).join(", ")} ${reorder.length === 1 ? "is" : "are"} at or below the reorder level. ` : "Nothing is below its reorder level. ")
          + (slow.length ? `${slow.map((i) => `${i.name} (${i.daysCover ?? "no"} days' cover)`).join(", ")} ${slow.length === 1 ? "is" : "are"} moving slowly, tying up ${gbp(s.totals.slowValue)}.` : "");
      },
    },
    {
      name: "fx_exposure", keywords: /fx|currency|dollar|usd|euro|exchange|sterling/i,
      description: "Foreign currency owed to suppliers and on order, valued at booked rates and at today's rate, with the effect of a 5% move",
      parameters: { type: "object", properties: {} },
      run: () => fxExposure(tx, providers),
      summarise: (r) => {
        const f = r as Awaited<ReturnType<typeof fxExposure>>;
        if (!f.currencies.length) return "You have no open foreign-currency bills or orders.";
        return f.currencies.map((c) => `You are short ${c.net.toLocaleString("en-GB")} ${c.currency} (${c.payable.toLocaleString("en-GB")} on bills, ${c.onOrder.toLocaleString("en-GB")} on order), worth ${gbp(c.gbpAtToday)} at today's rate. `
          + `A 5% move in sterling would change that by ${gbp(c.fivePercentMove)}. ${c.unrealised > 0 ? `It will cost ${gbp(c.unrealised)} more than booked.` : c.unrealised < 0 ? `It will cost ${gbp(-c.unrealised)} less than booked.` : ""}`).join(" ")
          + ` Realised exchange ${f.realisedThisYear >= 0 ? "gains" : "losses"} so far this year: ${gbp(Math.abs(f.realisedThisYear))}.`;
      },
    },
    {
      name: "supplier_performance", keywords: /supplier|lead time|vendor|factory|price rise|on time/i,
      description: "Per supplier: orders, spend, average lead time from order to receipt, price variance and price change",
      parameters: { type: "object", properties: {} },
      run: () => supplierPerformance(tx),
      summarise: (r) => {
        const s = r as Awaited<ReturnType<typeof supplierPerformance>>;
        if (!s.length) return "No purchase orders yet.";
        return s.map((x) => `${x.name}: ${x.orders} orders, ${gbp(x.spendGbp)} received, ${x.averageLeadDays ?? "?"} days order to arrival${x.priceChangePct ? `, prices ${x.priceChangePct > 0 ? "up" : "down"} ${Math.abs(x.priceChangePct)}%` : ""}.`).join(" ");
      },
    },
    {
      name: "landed_cost_by_shipment", keywords: /shipment|container|freight|duty|landed|uplift/i,
      description: "Per shipment: goods value, freight and duty landed, uplift on goods and cost per kg",
      parameters: { type: "object", properties: {} },
      run: () => landedCostByShipment(tx),
      summarise: (r) => {
        const s = (r as Awaited<ReturnType<typeof landedCostByShipment>>).filter((x) => x.status === "costed");
        if (!s.length) return "No shipments have been costed yet.";
        const avg = s.reduce((a, x) => a + x.upliftPct, 0) / s.length;
        const hi = [...s].sort((a, b) => b.upliftPct - a.upliftPct)[0]!;
        return `Freight and duty add ${avg.toFixed(1)}% on average to the cost of goods. The most expensive to land was ${hi.number} (${hi.reference}) at ${hi.upliftPct}%.`;
      },
    },
    {
      name: "key_ratios", keywords: /ratio|kpi|debtor days|dso|turn|health|overview|how are we doing/i,
      description: "Debtor days, creditor days, stock days, stock turn and gross margin over the last 90 days",
      parameters: { type: "object", properties: {} },
      run: () => kpis(tx),
      summarise: (r) => {
        const k = r as Awaited<ReturnType<typeof kpis>>;
        return `Over the last 90 days: gross margin ${k.grossMarginPct}%, customers pay in about ${k.debtorDays} days, you pay suppliers in about ${k.creditorDays} days, and stock turns ${k.stockTurn} times a year (${k.stockDays} days on hand).`;
      },
    },
    {
      name: "anomalies", keywords: /anomal|unusual|wrong|duplicate|check|error|problem|risk/i,
      description: "Month-end checks: possible duplicate bills, sales below cost, unusual prices, credit limits, VAT without a supplier VAT number, stale bank lines, uncosted shipments",
      parameters: { type: "object", properties: {} },
      run: () => anomalies(tx),
      summarise: (r) => {
        const a = r as Awaited<ReturnType<typeof anomalies>>;
        if (!a.length) return "The month-end checks found nothing unusual.";
        return `The checks found ${a.length} thing${a.length === 1 ? "" : "s"} to look at. ${a.slice(0, 3).map((x) => `${x.title}: ${x.detail}`).join(" ")}`;
      },
    },
  ];
}

export async function registerAssistant(app: FastifyInstance) {
  app.post("/api/assistant/ask", (req) => inTenant(req, async (tx, ctx) => {
    const { question } = z.object({ question: z.string().trim().min(3).max(1000) }).parse(req.body);
    const [t] = await tx.query<{ name: string }>("SELECT name FROM tenants");
    const info = app.providers.ai.info();
    const tools = assistantTools(tx, app.providers);
    const answer = await app.providers.ai.ask(question, { company: t!.name, today: today() }, tools);
    await tx.query(
      `INSERT INTO ai_interactions (id, tenant_id, user_id, kind, provider, model, input, output, tools_used, input_tokens, output_tokens)
       VALUES ($1,$2,$3,'assistant',$4,$5,$6,$7,$8,$9,$10)`,
      [newId(), ctx.tenantId, ctx.userId, info.mode === "live" ? "gemini" : "demo", answer.model, JSON.stringify({ question }),
        JSON.stringify({ answer: answer.answer }), JSON.stringify(answer.toolsUsed), answer.inputTokens ?? null, answer.outputTokens ?? null]);
    return { ...answer, provider: info.name };
  }));

  app.get("/api/assistant/history", (req) => inTenant(req, (tx, ctx) => tx.query(
    `SELECT id, input->>'question' AS question, output->>'answer' AS answer, tools_used, model, created_at FROM ai_interactions
      WHERE kind = 'assistant' AND user_id IS NOT DISTINCT FROM $1 ORDER BY created_at DESC LIMIT 30`, [ctx.userId])));
}
