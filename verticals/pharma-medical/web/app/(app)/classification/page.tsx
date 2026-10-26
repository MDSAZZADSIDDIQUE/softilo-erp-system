"use client";

import { useState } from "react";
import { Card, DataTable, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { qty } from "@/lib/format";

interface Product { id: string; sku: string; name: string; kind: string | null; legal_category: string | null; cd_schedule: number | null;
  storage: string | null; batch_tracked: boolean | null; licence_number: string | null; device_mark: string | null; released: string; quarantine: string }

const STORAGE: Record<string, string> = { ambient: "Ambient (15–25 °C)", cold_chain: "Cold chain (2–8 °C)", frozen: "Frozen" };

export default function ClassificationPage() {
  const { data, error, reload } = useApi<Product[]>("/api/pharma/products");
  const [editing, setEditing] = useState<Product | null>(null);
  const [saveError, setSaveError] = useState<string>();

  async function save() {
    if (!editing) return;
    try {
      await api(`/api/pharma/products/${editing.id}`, { method: "PUT", body: {
        kind: editing.kind ?? "medicine", legalCategory: editing.kind === "device" ? null : editing.legal_category,
        cdSchedule: editing.cd_schedule, storage: editing.storage ?? "ambient", batchTracked: editing.batch_tracked ?? true,
        licenceNumber: editing.licence_number || null, deviceMark: editing.device_mark || null,
      } });
      setEditing(null);
      setSaveError(undefined);
      await reload();
    } catch (e) {
      setSaveError((e as Error).message);
    }
  }
  const set = (patch: Partial<Product>) => setEditing({ ...editing!, ...patch });

  return (
    <div className="stack">
      <PageHeader title="Product classification" subtitle="Medicine or device, legal category, controlled-drug schedule, storage and batch tracking" />
      <ErrorBanner message={error ?? saveError} />
      {editing && (
        <Card title={`Classify ${editing.sku}`} pad>
          <div className="form-grid">
            <Field label="Kind">
              <select value={editing.kind ?? "medicine"} onChange={(e) => set({ kind: e.target.value })}>
                <option value="medicine">Medicine</option><option value="device">Medical device</option>
              </select>
            </Field>
            {editing.kind !== "device" ? <>
              <Field label="Legal category">
                <select value={editing.legal_category ?? ""} onChange={(e) => set({ legal_category: e.target.value || null })}>
                  <option value="">Choose…</option><option value="POM">POM: prescription only</option><option value="P">P: pharmacy</option><option value="GSL">GSL: general sale</option>
                </select>
              </Field>
              <Field label="Controlled drug schedule">
                <select value={editing.cd_schedule ?? ""} onChange={(e) => set({ cd_schedule: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">Not a controlled drug</option>
                  {[1, 2, 3, 4, 5].map((s) => <option key={s} value={s}>Schedule {s}</option>)}
                </select>
              </Field>
              <Field label="Product licence (PL) number"><input value={editing.licence_number ?? ""} onChange={(e) => set({ licence_number: e.target.value })} /></Field>
            </> : (
              <Field label="Conformity mark">
                <select value={editing.device_mark ?? ""} onChange={(e) => set({ device_mark: e.target.value || null })}>
                  <option value="">Not recorded</option><option value="UKCA">UKCA</option><option value="CE">CE</option><option value="CE_UKNI">CE + UKNI</option>
                </select>
              </Field>
            )}
            <Field label="Storage">
              <select value={editing.storage ?? "ambient"} onChange={(e) => set({ storage: e.target.value })}>
                {Object.entries(STORAGE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <label className="checkbox">
              <input type="checkbox" checked={editing.batch_tracked ?? true} onChange={(e) => set({ batch_tracked: e.target.checked })} />
              Track batches and expiry (cannot be switched off later)
            </label>
          </div>
          <div className="actions" style={{ marginTop: 12 }}>
            <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn primary" onClick={save}>Save</button>
          </div>
        </Card>
      )}
      <Card>
        <DataTable rows={data} empty={<div className="empty"><strong>No products yet</strong>Add products under Inventory first.</div>} columns={[
          { key: "sku", label: "Product", render: (p) => <><strong>{p.sku}</strong> <span className="muted">{p.name}</span></> },
          { key: "kind", label: "Class", render: (p) => !p.kind ? <span className="pill signal">Not classified</span>
            : p.kind === "device" ? `Device${p.device_mark ? ` · ${p.device_mark.replace("_", " + ")}` : ""}`
            : `${p.legal_category}${p.cd_schedule ? ` · CD Sch. ${p.cd_schedule}` : ""}` },
          { key: "storage", label: "Storage", render: (p) => (p.storage ? STORAGE[p.storage] : "–") },
          { key: "batch", label: "Batches", render: (p) => (p.batch_tracked ? "Tracked" : "–") },
          { key: "rel", label: "Released", num: true, render: (p) => qty(p.released) },
          { key: "q", label: "Quarantine", num: true, render: (p) => qty(p.quarantine) },
          { key: "edit", label: "", render: (p) => <button className="btn ghost" onClick={() => setEditing(p)}>Classify</button> },
        ]} />
      </Card>
    </div>
  );
}
