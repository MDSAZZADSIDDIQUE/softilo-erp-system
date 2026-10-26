"use client";

import { useState } from "react";
import { Card, DataTable, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { LICENCE_LABELS } from "@/components/pharma";
import { useContacts } from "@/components/pickers";
import { api, useApi } from "@/lib/api";
import { date, today } from "@/lib/format";

interface Licence { id: string; contact_id: string; customer_name: string; type: string; label: string; number: string;
  expires_on: string | null; verified_on: string | null; verification_source: string | null; status: string; problem: string | null;
  min_shelf_life_days: number }

const empty = { contactId: "", type: "gphc_pharmacy", number: "", validFrom: "", expiresOn: "", verifiedOn: today(), verificationSource: "" };

export default function LicencesPage() {
  const customers = useContacts("customer");
  const { data, error, reload } = useApi<Licence[]>("/api/pharma/licences");
  const [form, setForm] = useState(empty);
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof empty>) => setForm({ ...form, ...patch });

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setActionError(undefined);
    try {
      await fn();
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const add = () => act(async () => {
    await api(`/api/pharma/customers/${form.contactId}/licences`, { body: {
      type: form.type, number: form.number, validFrom: form.validFrom || null, expiresOn: form.expiresOn || null,
      verifiedOn: form.verifiedOn || null, verificationSource: form.verificationSource || null,
    } });
    setForm(empty);
  });

  const verify = (l: Licence) => {
    const source = window.prompt(`Where did you check ${l.number} today?`, l.verification_source ?? "");
    if (source) void act(() => api(`/api/pharma/licences/${l.id}/verify`, { body: { verifiedOn: today(), verificationSource: source } }));
  };

  return (
    <div className="stack">
      <PageHeader title="Customer licences" subtitle="Prescription-only (POM) and pharmacy (P) medicines are only supplied to customers with a verified, in-date entitlement" />
      <ErrorBanner message={error ?? actionError} />
      <Card title="Licences and registrations on file">
        <DataTable rows={data} empty={<div className="empty"><strong>No licences recorded</strong>Add each customer's WDA(H), GPhC premises number or other entitlement below.</div>} columns={[
          { key: "cust", label: "Customer", render: (l) => l.customer_name },
          { key: "type", label: "Licence", render: (l) => <>{l.label} <span className="mono">{l.number}</span></> },
          { key: "exp", label: "Expires", render: (l) => date(l.expires_on) },
          { key: "ver", label: "Verified", render: (l) => <>{date(l.verified_on)} <span className="muted">{l.verification_source}</span></> },
          { key: "shelf", label: "Min. shelf life", num: true, render: (l) => l.min_shelf_life_days ? `${l.min_shelf_life_days} days` : "–" },
          { key: "state", label: "Status", render: (l) => l.problem ? <span className="pill signal" title={l.problem}>Needs attention</span> : <span className="pill quiet ok">Good</span> },
          { key: "act", label: "", render: (l) => <div className="actions">
            <button className="btn ghost" disabled={busy} onClick={() => verify(l)}>Verify today</button>
            <button className="btn ghost" disabled={busy} onClick={() => act(() => api(`/api/pharma/licences/${l.id}/${l.status === "active" ? "suspend" : "reinstate"}`, { body: {} }))}>
              {l.status === "active" ? "Suspend" : "Reinstate"}
            </button>
          </div> },
        ]} />
        {data?.some((l) => l.problem) && (
          <div className="card-pad stack" style={{ gap: 4 }}>
            {data.filter((l) => l.problem).map((l) => <div key={l.id} className="muted">{l.customer_name}: {l.problem}</div>)}
          </div>
        )}
      </Card>
      <Card title="Add a licence" pad>
        <div className="form-grid">
          <Field label="Customer">
            <select value={form.contactId} onChange={(e) => set({ contactId: e.target.value })}>
              <option value="">Choose customer…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Type">
            <select value={form.type} onChange={(e) => set({ type: e.target.value })}>
              {Object.entries(LICENCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Number"><input value={form.number} onChange={(e) => set({ number: e.target.value })} /></Field>
          <Field label="Valid from"><input type="date" value={form.validFrom} onChange={(e) => set({ validFrom: e.target.value })} /></Field>
          <Field label="Expires"><input type="date" value={form.expiresOn} onChange={(e) => set({ expiresOn: e.target.value })} /></Field>
          <Field label="Verified on"><input type="date" value={form.verifiedOn} onChange={(e) => set({ verifiedOn: e.target.value })} /></Field>
          <Field label="Verified against" hint="e.g. GPhC register of premises, MHRA wholesale register">
            <input value={form.verificationSource} onChange={(e) => set({ verificationSource: e.target.value })} />
          </Field>
        </div>
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="btn primary" disabled={busy || !form.contactId || !form.number} onClick={add}>Add licence</button>
        </div>
      </Card>
      <ShelfLife customers={customers} onSaved={reload} />
    </div>
  );
}

function ShelfLife({ customers, onSaved }: { customers: { id: string; name: string }[]; onSaved: () => void }) {
  const [contactId, setContactId] = useState("");
  const [days, setDays] = useState("0");
  const [error, setError] = useState<string>();
  async function save() {
    try {
      await api(`/api/pharma/customers/${contactId}/profile`, { method: "PUT", body: { minShelfLifeDays: Number(days) } });
      setError(undefined);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Card title="Minimum remaining shelf life" pad>
      <ErrorBanner message={error} />
      <div className="form-grid">
        <Field label="Customer">
          <select value={contactId} onChange={(e) => setContactId(e.target.value)}>
            <option value="">Choose customer…</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Days" hint="FEFO skips batches that would leave this customer less shelf life"><input className="num" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></Field>
      </div>
      <div className="actions" style={{ marginTop: 12 }}><button className="btn" disabled={!contactId} onClick={save}>Save</button></div>
    </Card>
  );
}
