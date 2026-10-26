"use client";

import { useState } from "react";
import { Card, ErrorBanner, Field, Loading, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";

interface Settings {
  name: string; company_number: string | null; vat_number: string | null; vat_scheme: string; lock_date: string | null;
  address: { line1?: string; city?: string; postcode?: string; country?: string };
}

export default function SettingsPage() {
  const { data, error, reload } = useApi<Settings>("/api/settings");
  const { data: warehouses, reload: reloadWh } = useApi<{ id: string; code: string; name: string }[]>("/api/warehouses");
  const [msg, setMsg] = useState<string>();
  const [saveError, setSaveError] = useState<string>();

  if (!data) return error ? <ErrorBanner message={error} /> : <div className="card"><Loading /></div>;

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      await api("/api/settings", {
        method: "PATCH",
        body: {
          name: f.name, companyNumber: f.companyNumber || null, vatNumber: f.vatNumber || null, vatScheme: f.vatScheme,
          lockDate: f.lockDate || null,
          address: { line1: f.line1 || undefined, city: f.city || undefined, postcode: f.postcode || undefined, country: f.country || undefined },
        },
      });
      setMsg("Settings saved.");
      setSaveError(undefined);
      await reload();
    } catch (err) {
      setSaveError((err as Error).message);
    }
  }

  async function addWarehouse(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      await api("/api/warehouses", { body: Object.fromEntries(new FormData(form)) });
      form.reset();
      await reloadWh();
    } catch (err) {
      setSaveError((err as Error).message);
    }
  }

  return (
    <div className="stack">
      <form className="stack" onSubmit={save}>
        <PageHeader title="Settings"><button className="btn primary">Save changes</button></PageHeader>
        {msg && <div className="banner ok">{msg}</div>}
        <ErrorBanner message={saveError} />
        <Card title="Company" pad>
          <div className="form-grid">
            <Field label="Company name"><input name="name" defaultValue={data.name} required /></Field>
            <Field label="Company number"><input name="companyNumber" defaultValue={data.company_number ?? ""} maxLength={8} /></Field>
            <Field label="Address"><input name="line1" defaultValue={data.address?.line1 ?? ""} /></Field>
            <Field label="Town or city"><input name="city" defaultValue={data.address?.city ?? ""} /></Field>
            <Field label="Postcode"><input name="postcode" defaultValue={data.address?.postcode ?? ""} /></Field>
            <Field label="Country code"><input name="country" defaultValue={data.address?.country ?? "GB"} maxLength={2} /></Field>
          </div>
        </Card>
        <Card title="VAT and period lock" pad>
          <div className="form-grid">
            <Field label="VAT number"><input name="vatNumber" defaultValue={data.vat_number ? `GB${data.vat_number}` : ""} /></Field>
            <Field label="VAT accounting">
              <select name="vatScheme" defaultValue={data.vat_scheme}>
                <option value="standard">Standard (invoice basis)</option>
                <option value="cash">Cash accounting</option>
              </select>
            </Field>
            <Field label="Lock date" hint="Nothing can be posted on or before this date. Only the owner can move it back.">
              <input type="date" name="lockDate" defaultValue={data.lock_date ?? ""} />
            </Field>
          </div>
        </Card>
      </form>
      <Card title="Warehouses" pad>
        <ul style={{ margin: "0 0 16px", paddingLeft: 18 }}>
          {warehouses?.map((w) => <li key={w.id}><strong style={{ fontWeight: 500 }}>{w.code}</strong> · {w.name}</li>)}
        </ul>
        <form onSubmit={addWarehouse} className="form-grid" style={{ alignItems: "end" }}>
          <Field label="Code"><input name="code" required maxLength={20} /></Field>
          <Field label="Name"><input name="name" required /></Field>
          <button className="btn">Add warehouse</button>
        </form>
      </Card>
    </div>
  );
}
