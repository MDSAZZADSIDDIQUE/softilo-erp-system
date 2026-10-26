"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, Field, Money, PageHeader, Status, Tabs } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date, today } from "@/lib/format";
import type { FeeEarner, LawClient, MatterSummary } from "@law/lib/types";

function NewMatter({ onCancel }: { onCancel: () => void }) {
  const router = useRouter();
  const { data: clients } = useApi<LawClient[]>("/api/law/clients");
  const { data: earners } = useApi<FeeEarner[]>("/api/law/fee-earners");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    try {
      const m = await api<{ id: string }>("/api/law/matters", { body: f });
      router.push(`/matters/${m.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (clients && !clients.length) return <Card pad><Empty title="Add a client first"><Link href="/clients">Add a client</Link></Empty></Card>;
  if (earners && !earners.length) return <Card pad><Empty title="Add a fee earner first"><Link href="/fee-earners">Add a fee earner</Link></Empty></Card>;
  return (
    <Card title="Open a matter" pad>
      <form className="stack" onSubmit={submit}>
        <ErrorBanner message={error} />
        <div className="form-grid">
          <Field label="Client">
            <select name="clientId" required defaultValue="">
              <option value="" disabled>Choose a client</option>
              {clients?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Fee earner">
            <select name="feeEarnerId" required defaultValue="">
              <option value="" disabled>Who is responsible?</option>
              {earners?.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.initials})</option>)}
            </select>
          </Field>
          <Field label="Description"><input name="description" required placeholder="e.g. Purchase of 14 Mill Lane" /></Field>
          <Field label="Opened on"><input name="openedOn" type="date" defaultValue={today()} required /></Field>
        </div>
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? "Opening…" : "Open matter"}</button>
        </div>
      </form>
    </Card>
  );
}

export default function MattersPage() {
  const params = useSearchParams();
  const [adding, setAdding] = useState(params.get("new") === "1");
  const [status, setStatus] = useState("open");
  const { data, error } = useApi<MatterSummary[]>(`/api/law/matters${status === "all" ? "" : `?status=${status}`}`);

  return (
    <div className="stack">
      <PageHeader title="Matters" subtitle="Each matter keeps its own client and office ledger.">
        {!adding && <button className="btn primary" onClick={() => setAdding(true)}>Open a matter</button>}
      </PageHeader>
      <ErrorBanner message={error} />
      {adding && <NewMatter onCancel={() => setAdding(false)} />}
      <Tabs active={status} onChange={setStatus} tabs={[{ id: "open", label: "Open" }, { id: "closed", label: "Closed" }, { id: "all", label: "All" }]} />
      <Card>
        <DataTable rows={data} href={(r) => `/matters/${r.id}`}
          empty={<Empty title="No matters here">Open a matter to take money on account and record time.</Empty>}
          columns={[
            { key: "number", label: "Matter", render: (r) => <span className="mono" style={{ whiteSpace: "nowrap" }}>{r.number}</span> },
            { key: "client", label: "Client", render: (r) => r.client_name },
            { key: "description", label: "Description", render: (r) => r.description },
            { key: "fe", label: "Fee earner", render: (r) => r.fee_earner },
            { key: "opened", label: "Opened", render: (r) => date(r.opened_on) },
            { key: "status", label: "Status", render: (r) => <Status value={r.status} /> },
            { key: "client_balance", label: "Client account", num: true, render: (r) => <Money value={r.client_balance} /> },
            { key: "office_balance", label: "Office (owed)", num: true, render: (r) => <Money value={r.office_balance} /> },
            { key: "wip", label: "Unbilled time", num: true, render: (r) => <Money value={r.wip} /> },
          ]} />
      </Card>
    </div>
  );
}
