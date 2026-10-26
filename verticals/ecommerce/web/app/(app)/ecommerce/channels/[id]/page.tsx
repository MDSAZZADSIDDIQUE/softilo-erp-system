"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date, money } from "@/lib/format";
import { CHANNEL_LABEL, FEE_VAT_LABEL, JsonFileButton } from "@ecom/components/ecom";

interface Channel { id: string; kind: string; name: string; fee_vat_code: string; vat_treatment: string; orders: string; awaiting_payout: string }
interface ImportResult { imported: { id: string; orderNumber: string; invoiceNumber: string; total: string }[]; skipped: { orderNumber: string; reason: string }[] }
interface Split { sales: string; refunds: string; feesGross: string; feesNet: string; feesVat: string; feeVatCode: string; reserves: string; adjustments: string; computed: string; amount: string; difference: string; reconciled: boolean }
interface Preview { externalId: string; date: string; split: Split; problems: string[] }

export default function ChannelPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: channels, reload } = useApi<Channel[]>("/api/ecommerce/channels");
  const ch = channels?.find((c) => c.id === id);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult>();
  const [payout, setPayout] = useState<{ payload: unknown; preview: Preview }>();

  async function importOrders(payload: unknown) {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await api<ImportResult>(`/api/ecommerce/channels/${id}/orders/import`, { body: { payload } }));
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function previewPayout(payload: unknown) {
    setError(undefined);
    try {
      setPayout({ payload, preview: await api<Preview>(`/api/ecommerce/channels/${id}/payouts/preview`, { body: { payload } }) });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function postPayout() {
    if (!payout) return;
    setBusy(true);
    try {
      const r = await api<{ id: string }>(`/api/ecommerce/channels/${id}/payouts`, { body: { payload: payout.payload } });
      router.push(`/ecommerce/payouts/${r.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const s = payout?.preview.split;
  return (
    <div className="stack">
      <PageHeader title={ch?.name ?? "Channel"}
        subtitle={ch ? `${CHANNEL_LABEL[ch.kind] ?? ch.kind} · fees: ${FEE_VAT_LABEL[ch.fee_vat_code]} · ${money(ch.awaiting_payout)} awaiting payout` : undefined}>
        <Link className="btn ghost" href={`/ecommerce/orders?channelId=${id}`}>View orders</Link>
      </PageHeader>
      <ErrorBanner message={error} />
      <div className="grid-2">
        <Card title="Import orders" actions={<JsonFileButton label="Choose orders file" disabled={busy} onFile={importOrders} onError={setError} />} pad>
          <div className="stack" style={{ gap: 12 }}>
            <p className="muted" style={{ margin: 0 }}>
              Upload the orders export (Shopify Admin API JSON). Paid orders become sales invoices and take stock out at average cost.
              Orders already imported are skipped, so the same file can be uploaded again safely.
            </p>
            {result && <div className="banner ok">{result.imported.length} imported, {result.skipped.length} skipped</div>}
            {result && result.imported.length > 0 && (
              <DataTable rows={result.imported} href={(o) => `/ecommerce/orders/${o.id}`} columns={[
                { key: "o", label: "Order", render: (o) => o.orderNumber },
                { key: "i", label: "Invoice", render: (o) => o.invoiceNumber },
                { key: "t", label: "Total", num: true, render: (o) => money(o.total) },
              ]} />
            )}
            {result && result.skipped.length > 0 && (
              <DataTable rows={result.skipped} columns={[
                { key: "o", label: "Skipped", render: (o) => o.orderNumber },
                { key: "r", label: "Reason", render: (o) => o.reason },
              ]} />
            )}
          </div>
        </Card>
        <Card title="Reconcile a payout" actions={<JsonFileButton label="Choose payout file" disabled={busy} onFile={previewPayout} onError={setError} />} pad>
          <div className="stack" style={{ gap: 12 }}>
            <p className="muted" style={{ margin: 0 }}>
              Upload a Shopify Payments payout with its transactions. It is split into sales, refunds, fees and VAT,
              checked against what reached the bank, and settles the orders and refunds it covers.
            </p>
            {!payout && <Empty title="No payout loaded" />}
            {payout && s && (
              <>
                <strong>Payout {payout.preview.externalId} · {date(payout.preview.date)}</strong>
                <div className="totals" style={{ justifyContent: "start", padding: 0 }}>
                  <span>Sales collected</span><span className="mono num">{money(s.sales)}</span>
                  <span>Refunds paid</span><span className="mono num">{money(`-${s.refunds}`)}</span>
                  <span>Fees, net of VAT</span><span className="mono num">{money(`-${s.feesNet}`)}</span>
                  <span>VAT on fees ({s.feeVatCode === "RC20" ? "reverse charge, self-accounted" : s.feeVatCode})</span><span className="mono num">{money(s.feesVat)}</span>
                  <span>Reserves</span><span className="mono num">{money(s.reserves)}</span>
                  <span>Adjustments</span><span className="mono num">{money(s.adjustments)}</span>
                  <span className="grand">Paid to bank</span><span className="grand mono num">{money(s.amount)}</span>
                </div>
                {payout.preview.problems.length > 0
                  ? <div className="banner error" role="alert">{payout.preview.problems.map((p) => <div key={p}>{p}</div>)}</div>
                  : <div className="banner ok">Reconciles to the penny. Ready to post.</div>}
                <div className="actions">
                  <button className="btn primary" disabled={busy || payout.preview.problems.length > 0} onClick={postPayout}>Post payout</button>
                </div>
              </>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
