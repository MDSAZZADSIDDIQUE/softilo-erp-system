"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, Field, PageHeader, Stat } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date, money } from "@/lib/format";
import { CHANNEL_LABEL, FEE_VAT_LABEL } from "@ecom/components/ecom";

interface Channel { id: string; kind: string; name: string; fee_vat_code: string; vat_treatment: string; warehouse_code: string; orders: string; awaiting_payout: string; last_payout: string | null }
interface Summary { orders: string; awaiting_payout: string; net_sales: string; margin: string; fees: string; overdue_refunds: string }

export default function ChannelsPage() {
  const { data, error, reload } = useApi<Channel[]>("/api/ecommerce/channels");
  const { data: s } = useApi<Summary>("/api/ecommerce/summary");
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string>();

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      await api("/api/ecommerce/channels", { body: { kind: f.kind, name: f.name, feeVatCode: f.feeVatCode || undefined, vatTreatment: f.vatTreatment } });
      setAdding(false);
      setFormError(undefined);
      await reload();
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  return (
    <div className="stack">
      <PageHeader title="Sales channels" subtitle="Your shop and marketplaces: orders, payouts and returns post straight to the books">
        <button className="btn primary" onClick={() => setAdding((a) => !a)}>{adding ? "Cancel" : "Add channel"}</button>
      </PageHeader>
      <ErrorBanner message={error} />
      {s && (
        <div className="grid-4">
          <Stat label="Channel orders" value={s.orders} />
          <Stat label="Awaiting payout" value={money(s.awaiting_payout)} sub={Number(s.awaiting_payout) < 0 ? "Refunds to come off the next payout" : "Owed to you by your channels"} />
          <Stat label="Gross margin" value={money(s.margin)} sub={`on ${money(s.net_sales)} net sales`} />
          <Stat label="Refunds overdue" value={s.overdue_refunds} alert={Number(s.overdue_refunds) > 0} sub="14 days after goods came back" href="/ecommerce/returns" />
        </div>
      )}
      {adding && (
        <form onSubmit={add}>
          <Card title="New channel" pad>
            <ErrorBanner message={formError} />
            <div className="form-grid">
              <Field label="Channel">
                <select name="kind" defaultValue="shopify">
                  {Object.entries(CHANNEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}{k === "shopify" ? "" : " (import coming soon)"}</option>)}
                </select>
              </Field>
              <Field label="Name"><input name="name" required placeholder="e.g. Online shop" /></Field>
              <Field label="VAT on the channel's fees" hint="Leave as default unless your accountant says otherwise">
                <select name="feeVatCode" defaultValue="">
                  <option value="">Default for this channel</option>
                  {Object.entries(FEE_VAT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              <Field label="Who accounts for VAT on sales" hint="Marketplaces collect VAT only in some cases, e.g. overseas sellers">
                <select name="vatTreatment" defaultValue="seller">
                  <option value="seller">We do (UK-established seller)</option>
                  <option value="marketplace">The marketplace (deemed supplier)</option>
                  <option value="export">Nobody: exports, zero-rated</option>
                </select>
              </Field>
            </div>
            <div className="actions" style={{ marginTop: 16 }}><button className="btn primary">Save channel</button></div>
          </Card>
        </form>
      )}
      <Card>
        <DataTable rows={data} href={(c) => `/ecommerce/channels/${c.id}`}
          empty={<Empty title="No channels yet">Add your Shopify store to import its orders.</Empty>}
          columns={[
            { key: "n", label: "Channel", render: (c) => <Link href={`/ecommerce/channels/${c.id}`}>{c.name}</Link> },
            { key: "k", label: "Type", render: (c) => CHANNEL_LABEL[c.kind] ?? c.kind },
            { key: "w", label: "Ships from", render: (c) => c.warehouse_code },
            { key: "f", label: "Fee VAT", render: (c) => FEE_VAT_LABEL[c.fee_vat_code] ?? c.fee_vat_code },
            { key: "o", label: "Orders", num: true, render: (c) => c.orders },
            { key: "a", label: "Awaiting payout", num: true, render: (c) => money(c.awaiting_payout) },
            { key: "p", label: "Last payout", render: (c) => date(c.last_payout) },
          ]} />
      </Card>
    </div>
  );
}
