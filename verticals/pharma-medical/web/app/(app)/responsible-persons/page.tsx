"use client";

import { useState } from "react";
import { Card, DataTable, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date, today } from "@/lib/format";

interface Rp { id: string; user_id: string; name: string; email: string; appointed_on: string; active: boolean }
interface User { id: string; name: string; email: string; role: string }

export default function ResponsiblePersonsPage() {
  const { data, error, reload } = useApi<Rp[]>("/api/pharma/responsible-persons");
  const { data: users } = useApi<User[]>("/api/pharma/users");
  const [userId, setUserId] = useState("");
  const [appointedOn, setAppointedOn] = useState(today());
  const [actionError, setActionError] = useState<string>();

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      setActionError(undefined);
      await reload();
    } catch (e) {
      setActionError((e as Error).message);
    }
  }

  return (
    <div className="stack">
      <PageHeader title="Responsible Persons" subtitle="People named on your WDA(H) who may release, reject and recall batches" />
      <ErrorBanner message={error ?? actionError} />
      <Card>
        <DataTable rows={data} empty={<div className="empty"><strong>No Responsible Person named</strong>Until one is named, no batch can be released for sale.</div>} columns={[
          { key: "name", label: "Name", render: (r) => <>{r.name} <span className="muted">{r.email}</span></> },
          { key: "from", label: "Appointed", render: (r) => date(r.appointed_on) },
          { key: "st", label: "Status", render: (r) => r.active ? <span className="pill quiet ok">Active</span> : <span className="pill quiet">Stood down</span> },
          { key: "act", label: "", render: (r) => r.active && <button className="btn ghost" onClick={() => act(() => api(`/api/pharma/responsible-persons/${r.id}/stand-down`, { body: {} }))}>Stand down</button> },
        ]} />
      </Card>
      <Card title="Name a Responsible Person" pad>
        <div className="form-grid">
          <Field label="User">
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose user…</option>
              {(users ?? []).map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
            </select>
          </Field>
          <Field label="Appointed on"><input type="date" value={appointedOn} onChange={(e) => setAppointedOn(e.target.value)} /></Field>
        </div>
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="btn primary" disabled={!userId} onClick={() => act(() => api("/api/pharma/responsible-persons", { body: { userId, appointedOn } }))}>Name as RP</button>
        </div>
      </Card>
    </div>
  );
}
