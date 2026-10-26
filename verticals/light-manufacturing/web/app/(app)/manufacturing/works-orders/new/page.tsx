"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Card, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";

interface BomRow { product_id: string; sku: string; name: string; is_active: boolean; version: number }

function NewWorksOrderForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { data: boms } = useApi<BomRow[]>("/api/mfg/boms");
  const { data: warehouses } = useApi<{ id: string; name: string }[]>("/api/warehouses");
  const makeable = boms?.filter((b) => b.is_active) ?? [];
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    try {
      const { id } = await api("/api/mfg/works-orders", {
        body: {
          productId: f.productId, quantity: f.quantity, warehouseId: f.warehouseId || undefined,
          dueDate: f.dueDate || undefined, notes: f.notes || undefined, release: f.release === "on",
        },
      });
      router.push(`/manufacturing/works-orders/${id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <PageHeader title="New works order" subtitle="Component requirements are taken from the active bill of materials when you save.">
        <button type="button" className="btn ghost" onClick={() => router.back()}>Cancel</button>
        <button className="btn primary" disabled={busy || !makeable.length}>Save works order</button>
      </PageHeader>
      <ErrorBanner message={error} />
      {boms && !makeable.length && <div className="banner">Create a bill of materials first: only products with an active BOM can be made.</div>}
      <Card title="Order" pad>
        <div className="form-grid">
          <Field label="Product to make">
            {/* Keyed so the default selection applies once the BOM list has loaded. */}
            <select key={makeable.length} name="productId" required defaultValue={params.get("product") ?? ""}>
              <option value="">Choose product…</option>
              {makeable.map((b) => <option key={b.product_id} value={b.product_id}>{b.sku} · {b.name} (BOM v{b.version})</option>)}
            </select>
          </Field>
          <Field label="Quantity"><input name="quantity" className="num" inputMode="decimal" required defaultValue={params.get("quantity") ?? ""} /></Field>
          <Field label="Due date"><input type="date" name="dueDate" /></Field>
          <Field label="Make in">
            <select name="warehouseId">{warehouses?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
          </Field>
        </div>
        <label className="checkbox" style={{ marginTop: 16 }}>
          <input type="checkbox" name="release" /> Release to the shop floor now
        </label>
      </Card>
      <Card title="Notes" pad><textarea name="notes" aria-label="Notes" style={{ minHeight: 80 }} /></Card>
    </form>
  );
}

export default function NewWorksOrderPage() {
  return <Suspense><NewWorksOrderForm /></Suspense>;
}
