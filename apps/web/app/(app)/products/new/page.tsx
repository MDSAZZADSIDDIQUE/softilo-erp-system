"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import { VAT_CODES } from "@/lib/format";

export default function NewProductPage() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    try {
      const { id } = await api("/api/products", {
        body: {
          sku: f.sku, name: f.name, description: f.description || undefined, uom: f.uom || "each",
          hsCode: f.hsCode || undefined, barcode: f.barcode || undefined,
          weightKg: f.weightKg || undefined, volumeM3: f.volumeM3 || undefined,
          salesPrice: f.salesPrice || "0", salesVatCode: f.salesVatCode, purchaseVatCode: f.purchaseVatCode,
          trackStock: f.trackStock === "on", reorderLevel: f.reorderLevel || undefined,
        },
      });
      router.push(`/products/${id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <PageHeader title="New product">
        <button type="button" className="btn ghost" onClick={() => router.back()}>Cancel</button>
        <button className="btn primary" disabled={busy}>Save product</button>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card title="Product" pad>
        <div className="form-grid">
          <Field label="SKU"><input name="sku" required autoFocus /></Field>
          <Field label="Name"><input name="name" required /></Field>
          <Field label="Unit of measure"><input name="uom" defaultValue="each" /></Field>
          <Field label="Barcode"><input name="barcode" /></Field>
          <Field label="Sale price (£, ex VAT)"><input name="salesPrice" inputMode="decimal" className="num" placeholder="0.00" /></Field>
          <Field label="Sales VAT">
            <select name="salesVatCode" defaultValue="S20">{VAT_CODES.map((v) => <option key={v.code} value={v.code}>{v.label}</option>)}</select>
          </Field>
          <Field label="Purchase VAT" hint="Use Outside scope for overseas suppliers">
            <select name="purchaseVatCode" defaultValue="S20">{VAT_CODES.map((v) => <option key={v.code} value={v.code}>{v.label}</option>)}</select>
          </Field>
          <Field label="Reorder level"><input name="reorderLevel" inputMode="decimal" className="num" /></Field>
        </div>
        <label className="checkbox" style={{ marginTop: 16 }}><input type="checkbox" name="trackStock" defaultChecked /> Track stock for this product</label>
      </Card>
      <Card title="Importing" pad>
        <p className="muted" style={{ marginTop: 0 }}>Used to calculate duty and to spread freight across a shipment by weight or volume.</p>
        <div className="form-grid">
          <Field label="Commodity code" hint="6–10 digit UK tariff code"><input name="hsCode" inputMode="numeric" /></Field>
          <Field label="Weight per unit (kg)"><input name="weightKg" inputMode="decimal" className="num" /></Field>
          <Field label="Volume per unit (m³)"><input name="volumeM3" inputMode="decimal" className="num" /></Field>
        </div>
      </Card>
      <Card title="Description" pad>
        <textarea name="description" aria-label="Description" />
      </Card>
    </form>
  );
}
