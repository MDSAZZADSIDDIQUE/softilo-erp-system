"use client";

import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, Field, Money, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import type { LawClient } from "@law/lib/types";

export default function ClientsPage() {
  const { data, error, reload } = useApi<LawClient[]>("/api/law/clients");
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string>();

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    try {
      await api("/api/law/clients", { body: { ...f, cddComplete: f.cddComplete === "on" } });
      form.reset();
      setAdding(false);
      setFormError(undefined);
      await reload();
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  return (
    <div className="stack">
      <PageHeader title="Clients" subtitle="People and organisations you act for.">
        {!adding && <button className="btn primary" onClick={() => setAdding(true)}>Add a client</button>}
      </PageHeader>
      <ErrorBanner message={error} />
      {adding && (
        <Card title="New client" pad>
          <form className="stack" onSubmit={submit}>
            <ErrorBanner message={formError} />
            <div className="form-grid">
              <Field label="Name"><input name="name" required autoFocus /></Field>
              <Field label="Type">
                <select name="clientType" defaultValue="individual">
                  <option value="individual">Individual</option>
                  <option value="organisation">Organisation</option>
                </select>
              </Field>
              <Field label="Email"><input name="email" type="email" /></Field>
              <Field label="Phone"><input name="phone" /></Field>
            </div>
            <label className="checkbox"><input type="checkbox" name="cddComplete" /> Client due diligence is complete</label>
            <div className="actions">
              <button type="button" className="btn ghost" onClick={() => setAdding(false)}>Cancel</button>
              <button className="btn primary">Add client</button>
            </div>
          </form>
        </Card>
      )}
      <Card>
        <DataTable rows={data}
          empty={<Empty title="No clients yet">Add the people and organisations you act for.</Empty>}
          columns={[
            { key: "name", label: "Name", render: (r) => r.name },
            { key: "type", label: "Type", render: (r) => (r.client_type === "individual" ? "Individual" : "Organisation") },
            { key: "cdd", label: "Due diligence", render: (r) => <span className={`pill ${r.cdd_status === "complete" ? "quiet ok" : "signal"}`}>{r.cdd_status === "complete" ? "Complete" : "Pending"}</span> },
            { key: "email", label: "Email", render: (r) => r.email ?? "–" },
            { key: "matters", label: "Matters", num: true, render: (r) => r.matters },
            { key: "balance", label: "Client money held", num: true, render: (r) => <Money value={r.client_balance} /> },
          ]} />
      </Card>
    </div>
  );
}
