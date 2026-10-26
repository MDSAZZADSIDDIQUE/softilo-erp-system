"use client";

import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, Field, PageHeader, Tabs } from "@core/components/ui";
import { api, useApi } from "@core/lib/api";
import { qty } from "@core/lib/format";
import { ALLERGENS, dateTypeLabel } from "@/components/fnb";

interface Product {
  id: string; sku: string; name: string; on_hand: string; batch_tracked: boolean; date_type: string | null;
  shelf_life_days: number | null; storage: string | null; allergens: string[];
}
interface Customer { id: string; name: string; min_life_days: number }

const allergenLabel = (id: string) => ALLERGENS.find((a) => a.id === id)?.label ?? id;

function ProductForm({ product, onDone }: { product: Product; onDone: () => void }) {
  const [allergens, setAllergens] = useState<string[]>(product.allergens);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    try {
      await api(`/api/fnb/products/${product.id}/settings`, {
        method: "PUT",
        body: {
          batchTracked: f.batchTracked === "on", dateType: f.dateType, storage: f.storage, allergens,
          shelfLifeDays: f.shelfLifeDays ? Number(f.shelfLifeDays) : null,
        },
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Card title={`${product.sku} · ${product.name}`} pad>
      <ErrorBanner message={error} />
      <form className="stack" onSubmit={save}>
        <div className="form-grid">
          <Field label="Batch tracking" hint="Switch on while there is no stock on hand">
            <label className="checkbox"><input type="checkbox" name="batchTracked" defaultChecked={product.batch_tracked || !product.date_type} /> Track batches and dates</label>
          </Field>
          <Field label="Date mark" hint="Use-by stock is never sold past its date">
            <select name="dateType" defaultValue={product.date_type ?? "use_by"}>
              <option value="use_by">Use by (safety)</option>
              <option value="best_before">Best before (quality)</option>
            </select>
          </Field>
          <Field label="Shelf life (days)" hint="Fills in the date when a delivery has none printed">
            <input name="shelfLifeDays" className="num" inputMode="numeric" defaultValue={product.shelf_life_days ?? ""} />
          </Field>
          <Field label="Storage">
            <select name="storage" defaultValue={product.storage ?? "ambient"}>
              <option value="ambient">Ambient</option>
              <option value="chilled">Chilled</option>
              <option value="frozen">Frozen</option>
            </select>
          </Field>
        </div>
        <Field label="Allergens" hint="The 14 allergens that must be declared and emphasised on labels">
          <div className="allergens">
            {ALLERGENS.map((a) => (
              <label key={a.id}>
                <input type="checkbox" checked={allergens.includes(a.id)}
                  onChange={(e) => setAllergens((xs) => (e.target.checked ? [...xs, a.id] : xs.filter((x) => x !== a.id)))} />
                {a.label}
              </label>
            ))}
          </div>
        </Field>
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onDone}>Cancel</button>
          <button className="btn primary" disabled={busy}>Save</button>
        </div>
      </form>
    </Card>
  );
}

function CustomerRow({ customer, onSaved }: { customer: Customer; onSaved: () => void }) {
  const [value, setValue] = useState(String(customer.min_life_days));
  const [error, setError] = useState<string>();
  const dirty = value !== String(customer.min_life_days);
  async function save() {
    try {
      await api(`/api/fnb/customers/${customer.id}/settings`, { method: "PUT", body: { minLifeDays: Number(value || 0) } });
      setError(undefined);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
      {error && <small style={{ color: "var(--accent-text)" }}>{error}</small>}
      <input className="num" inputMode="numeric" aria-label={`Minimum life for ${customer.name}`} value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 80 }} />
      <button className="btn small" disabled={!dirty} onClick={save}>Save</button>
    </span>
  );
}

export default function FoodSettingsPage() {
  const [tab, setTab] = useState("products");
  const products = useApi<Product[]>("/api/fnb/products");
  const customers = useApi<Customer[]>(tab === "customers" ? "/api/fnb/customers" : null);
  const [editing, setEditing] = useState<Product>();

  return (
    <div className="stack">
      <PageHeader title="Food settings" subtitle="Which products carry batches and dates, their allergens, and the shelf life each customer needs on delivery." />
      <Tabs tabs={[{ id: "products", label: "Products" }, { id: "customers", label: "Customer shelf-life rules" }]} active={tab} onChange={setTab} />
      <ErrorBanner message={products.error ?? customers.error} />
      {tab === "products" && <>
        {editing && <ProductForm key={editing.id} product={editing} onDone={() => { setEditing(undefined); void products.reload(); }} />}
        <Card>
          <DataTable rows={products.data} empty={<Empty title="No products yet" />} columns={[
            { key: "sku", label: "SKU", render: (p) => p.sku },
            { key: "n", label: "Product", render: (p) => p.name },
            { key: "t", label: "Batches", render: (p) => p.batch_tracked ? <span className="pill quiet ok">{dateTypeLabel(p.date_type)}</span> : <span className="faint">Not tracked</span> },
            { key: "l", label: "Shelf life", num: true, render: (p) => p.shelf_life_days !== null ? `${p.shelf_life_days} days` : <span className="faint">–</span> },
            { key: "s", label: "Storage", render: (p) => p.storage ? p.storage[0]!.toUpperCase() + p.storage.slice(1) : <span className="faint">–</span> },
            { key: "a", label: "Allergens", render: (p) => p.allergens.length ? p.allergens.map(allergenLabel).join(", ") : <span className="faint">None declared</span> },
            { key: "q", label: "On hand", num: true, render: (p) => qty(p.on_hand) },
            { key: "e", label: "", render: (p) => <button className="btn small" onClick={() => { setEditing(p); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Edit</button> },
          ]} />
        </Card>
      </>}
      {tab === "customers" && (
        <Card>
          <DataTable rows={customers.data} empty={<Empty title="No customers yet" />} columns={[
            { key: "n", label: "Customer", render: (c) => c.name },
            { key: "m", label: "Minimum days of life on delivery", num: true, render: (c) => <CustomerRow customer={c} onSaved={() => void customers.reload()} /> },
          ]} />
        </Card>
      )}
    </div>
  );
}
