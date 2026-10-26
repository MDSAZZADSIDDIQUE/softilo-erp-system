"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { Card, DataTable, ErrorBanner, Field, Loading, PageHeader, Stat } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date, money, qty, today } from "@/lib/format";

interface Product {
  id: string; sku: string; name: string; description: string | null; uom: string; hs_code: string | null;
  weight_kg: string | null; volume_m3: string | null; sales_price: string; sales_vat_code: string; purchase_vat_code: string;
  track_stock: boolean; reorder_level: string | null;
  stock: { warehouse_id: string; code: string; name: string; quantity: string; value: string }[];
  movements: { date: string; kind: string; quantity: string; value: string; source_type: string; warehouse: string }[];
}

const KIND: Record<string, string> = { receipt: "Goods received", issue: "Sold", return: "Returned", landed_cost: "Landed cost", adjustment: "Adjustment" };

export default function ProductPage() {
  const { id } = useParams<{ id: string }>();
  const { data: p, error, reload } = useApi<Product>(`/api/products/${id}`);
  const [adjusting, setAdjusting] = useState(false);
  const [adjError, setAdjError] = useState<string>();

  if (!p) return error ? <ErrorBanner message={error} /> : <div className="card"><Loading /></div>;
  const onHand = p.stock.reduce((s, w) => s + Number(w.quantity), 0);
  const value = p.stock.reduce((s, w) => s + Number(w.value), 0);

  async function adjust(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      await api("/api/stock/adjustments", {
        body: { date: f.date, productId: id, warehouseId: f.warehouseId, quantity: f.quantity, unitCostGbp: f.unitCost || undefined, reason: f.reason, offsetAccount: "5000" },
      });
      setAdjusting(false);
      setAdjError(undefined);
      await reload();
    } catch (err) {
      setAdjError((err as Error).message);
    }
  }

  return (
    <div className="stack">
      <PageHeader title={p.name} subtitle={<>{p.sku}{p.hs_code && <> · Commodity code {p.hs_code}</>}</>}>
        {p.track_stock && <button className="btn" onClick={() => setAdjusting((a) => !a)}>Adjust stock</button>}
      </PageHeader>
      <div className="grid-4">
        <Stat label="On hand" value={qty(onHand)} sub={p.uom} />
        <Stat label="Stock value" value={money(value)} />
        <Stat label="Average landed cost" value={onHand ? `£${(value / onHand).toFixed(4)}` : "–"} />
        <Stat label="Sale price" value={money(p.sales_price)} sub={onHand && Number(p.sales_price) ? `${(((Number(p.sales_price) - value / onHand) / Number(p.sales_price)) * 100).toFixed(1)}% margin at current cost` : undefined} />
      </div>
      {adjusting && (
        <Card title="Stock adjustment" pad>
          <form onSubmit={adjust} className="stack" style={{ gap: 14 }}>
            <ErrorBanner message={adjError} />
            <div className="form-grid">
              <Field label="Date"><input type="date" name="date" defaultValue={today()} required /></Field>
              <Field label="Warehouse">
                <select name="warehouseId">{p.stock.map((w) => <option key={w.warehouse_id} value={w.warehouse_id}>{w.name}</option>)}</select>
              </Field>
              <Field label="Quantity" hint="Negative to write off"><input name="quantity" inputMode="decimal" className="num" required /></Field>
              <Field label="Unit cost (£)" hint="For increases; defaults to average cost"><input name="unitCost" inputMode="decimal" className="num" /></Field>
              <Field label="Reason"><input name="reason" required placeholder="e.g. Stock take 31 Oct" /></Field>
            </div>
            <div className="actions"><button className="btn primary">Post adjustment</button></div>
          </form>
        </Card>
      )}
      <div className="grid-2">
        <Card title="By warehouse">
          <DataTable rows={p.stock} columns={[
            { key: "w", label: "Warehouse", render: (w) => w.name },
            { key: "q", label: "Quantity", num: true, render: (w) => qty(w.quantity) },
            { key: "v", label: "Value", num: true, render: (w) => money(w.value) },
          ]} />
        </Card>
        <Card title="Details" pad>
          <dl className="meta">
            <dt>Unit</dt><dd>{p.uom}</dd>
            <dt>Weight</dt><dd>{p.weight_kg ? `${Number(p.weight_kg)} kg` : "–"}</dd>
            <dt>Volume</dt><dd>{p.volume_m3 ? `${Number(p.volume_m3)} m³` : "–"}</dd>
            <dt>Sales VAT</dt><dd>{p.sales_vat_code}</dd>
            <dt>Purchase VAT</dt><dd>{p.purchase_vat_code}</dd>
            <dt>Reorder level</dt><dd>{p.reorder_level ? qty(p.reorder_level) : "–"}</dd>
          </dl>
        </Card>
      </div>
      <Card title="Stock movements">
        <DataTable rows={p.movements} columns={[
          { key: "d", label: "Date", render: (m) => date(m.date) },
          { key: "k", label: "Movement", render: (m) => KIND[m.kind] ?? m.kind },
          { key: "w", label: "Warehouse", render: (m) => m.warehouse },
          { key: "q", label: "Quantity", num: true, render: (m) => Number(m.quantity) === 0 ? "–" : qty(m.quantity) },
          { key: "v", label: "Value", num: true, render: (m) => money(m.value) },
        ]} />
      </Card>
    </div>
  );
}
