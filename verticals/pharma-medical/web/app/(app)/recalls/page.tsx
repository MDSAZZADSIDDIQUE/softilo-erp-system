"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Card, DataTable, ErrorBanner, Field, PageHeader, Stat } from "@/components/ui";
import { BatchStatus, useIsRp } from "@/components/pharma";
import { api } from "@/lib/api";
import { date, qty } from "@/lib/format";

interface Trace {
  product: { id: string; sku: string; name: string }; batchNumber: string; received: string; supplied: string; onHand: string; customers: number;
  lots: { id: string; status: string; expiry: string; received_on: string; received_qty: string; on_hand: string; warehouse_name: string;
    supplier_name: string; receipt_number: string; po_number: string }[];
  supplies: { date: string; customer_name: string; customer_email: string | null; invoice_id: string; invoice_number: string; quantity: string }[];
}
interface Product { id: string; sku: string; name: string; batch_tracked: boolean | null }

export default function RecallsPage() {
  const params = useSearchParams();
  const isRp = useIsRp();
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState(params.get("productId") ?? "");
  const [batchNumber, setBatchNumber] = useState(params.get("batch") ?? "");
  const [trace, setTrace] = useState<Trace>();
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => { void api<Product[]>("/api/pharma/products").then((p) => setProducts(p.filter((x) => x.batch_tracked))); }, []);

  async function run(fn: () => Promise<Trace>) {
    setBusy(true);
    setError(undefined);
    try {
      setTrace(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const find = () => run(() => api<Trace>(`/api/pharma/trace?productId=${productId}&batchNumber=${encodeURIComponent(batchNumber)}`));
  useEffect(() => { if (productId && batchNumber) void find(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const recall = () => run(() => api<Trace>("/api/pharma/recalls", { body: { productId, batchNumber, reason, reference: reference || undefined } }));
  const allRecalled = trace?.lots.length && trace.lots.every((l) => l.status === "recalled");

  return (
    <div className="stack">
      <PageHeader title="Recalls & trace" subtitle="Find every receipt and every customer supply of a batch, and stop it being sold" />
      <ErrorBanner message={error} />
      <Card pad>
        <div className="form-grid">
          <Field label="Product">
            <select value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">Choose product…</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}
            </select>
          </Field>
          <Field label="Batch number"><input value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)} /></Field>
        </div>
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="btn primary" disabled={busy || !productId || !batchNumber} onClick={find}>Trace batch</button>
        </div>
      </Card>
      {trace && <>
        <div className="grid-4">
          <Stat label="Received" value={qty(trace.received)} sub={`${trace.lots.length} receipt${trace.lots.length === 1 ? "" : "s"}`} />
          <Stat label="Supplied" value={qty(trace.supplied)} sub={`${trace.customers} customer${trace.customers === 1 ? "" : "s"}`} alert={Number(trace.supplied) > 0 && Boolean(allRecalled)} />
          <Stat label="Still on hand" value={qty(trace.onHand)} sub="quarantine for return or destruction" />
          <Stat label="Status" value={allRecalled ? "Recalled" : trace.lots.length ? "Not recalled" : "–"} />
        </div>
        <Card title={`Receipts of ${trace.product.sku} batch ${trace.batchNumber}`}>
          <DataTable rows={trace.lots} href={(l) => `/batches/${l.id}`} empty={<div className="empty"><strong>No receipts of this batch</strong></div>} columns={[
            { key: "grn", label: "Receipt", render: (l) => `${l.receipt_number} (${l.po_number})` },
            { key: "sup", label: "Supplier", render: (l) => l.supplier_name },
            { key: "date", label: "Received", render: (l) => date(l.received_on) },
            { key: "exp", label: "Expiry", render: (l) => date(l.expiry) },
            { key: "qty", label: "Received", num: true, render: (l) => qty(l.received_qty) },
            { key: "on", label: "On hand", num: true, render: (l) => qty(l.on_hand) },
            { key: "st", label: "Status", render: (l) => <BatchStatus value={l.status} /> },
          ]} />
        </Card>
        <Card title="Customers supplied">
          <DataTable rows={trace.supplies} empty={<div className="empty"><strong>Not supplied to any customer</strong></div>} columns={[
            { key: "date", label: "Date", render: (s) => date(s.date) },
            { key: "cust", label: "Customer", render: (s) => <>{s.customer_name} {s.customer_email && <span className="muted">{s.customer_email}</span>}</> },
            { key: "inv", label: "Invoice", render: (s) => <Link href={`/invoices/${s.invoice_id}`}>{s.invoice_number}</Link> },
            { key: "qty", label: "Quantity", num: true, render: (s) => qty(s.quantity) },
          ]} />
        </Card>
        {!allRecalled && trace.lots.length > 0 && (
          <Card title="Recall this batch" pad>
            {isRp ? <>
              <div className="form-grid">
                <Field label="Reason"><textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                <Field label="Alert or recall reference" hint="e.g. the MHRA drug alert number"><input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
              </div>
              <div className="actions" style={{ marginTop: 12 }}>
                <button className="btn primary" disabled={busy || !reason.trim()} onClick={recall}>Recall every receipt of this batch</button>
              </div>
            </> : <div className="muted">Only a named Responsible Person can recall a batch.</div>}
          </Card>
        )}
      </>}
    </div>
  );
}
