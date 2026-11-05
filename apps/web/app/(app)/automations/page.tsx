"use client";

import Link from "next/link";
import { useState } from "react";
import { AccountSelect, useAccounts, VatSelect } from "@/components/pickers";
import { Card, DataTable, Empty, ErrorBanner, Field, PageHeader, Tabs } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { dateTime } from "@/lib/format";

interface Automation { kind: string; title: string; description: string; everyMinutes: number; enabled: boolean; settings: Record<string, unknown>; lastRun: { status: string; summary: string; finished_at: string } | null }
interface Run { id: string; kind: string; trigger: string; status: string; summary: string; actions: { type: string; entity: string; id?: string; label: string }[]; started_at: string }
interface Rule { id: string; name: string; match_text: string; direction: string; account_code: string; account_name: string; vat_code: string; active: boolean; times_used: string }
interface Message { id: string; template: string; to_address: string; to_name: string | null; subject: string; body: string; status: string; mode: string; created_by: string; created_at: string; error: string | null }

const every = (m: number) => (m >= 1440 ? "Daily" : m >= 60 ? `Every ${m / 60} hour${m === 60 ? "" : "s"}` : `Every ${m} minutes`);
const RUN_TONE: Record<string, string> = { ok: "quiet ok", partial: "signal", failed: "signal", skipped: "quiet" };
const RUN_LABEL: Record<string, string> = { ok: "Done", partial: "Partly done", failed: "Failed", skipped: "Nothing to do" };
const LINK: Record<string, (id: string) => string> = {
  purchase_order: (id) => `/purchase-orders/${id}`, sales_invoice: (id) => `/invoices/${id}`, document: (id) => `/inbox/${id}`, bank_transaction: () => "/banking?status=reconciled",
};

function Rules({ onError }: { onError: (m?: string) => void }) {
  const { data, reload } = useApi<Rule[]>("/api/bank/rules");
  const accounts = useAccounts((a) => !a.is_control && !a.is_bank);
  const [form, setForm] = useState({ name: "", matchText: "", direction: "out", accountCode: "", vatCode: "EX" });
  async function add(e: React.FormEvent) {
    e.preventDefault();
    try { await api("/api/bank/rules", { body: form }); setForm({ name: "", matchText: "", direction: "out", accountCode: "", vatCode: "EX" }); onError(); await reload(); }
    catch (err) { onError((err as Error).message); }
  }
  return (
    <div className="grid-main">
      <Card title="Bank rules">
        <DataTable rows={data} empty={<Empty title="No rules yet">Rules code bank lines that never have an invoice: fees, fuel, direct debits.</Empty>} columns={[
          { key: "n", label: "Rule", render: (r) => <span>{r.name}<br /><small className="faint">Description contains “{r.match_text}” · money {r.direction}</small></span> },
          { key: "a", label: "Posts to", render: (r) => `${r.account_code} ${r.account_name}` },
          { key: "v", label: "VAT", render: (r) => r.vat_code },
          { key: "u", label: "Used", num: true, render: (r) => r.times_used },
          { key: "on", label: "", render: (r) => <label className="switch"><input type="checkbox" checked={r.active} onChange={async (e) => { await api(`/api/bank/rules/${r.id}`, { method: "PATCH", body: { active: e.target.checked } }); await reload(); }} aria-label={`${r.name} active`} /></label> },
        ]} />
      </Card>
      <Card title="New rule" pad>
        <form className="stack" style={{ gap: 12 }} onSubmit={add}>
          <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="Parking" /></Field>
          <Field label="When the bank line contains" hint="Not case-sensitive"><input value={form.matchText} onChange={(e) => setForm({ ...form, matchText: e.target.value })} required minLength={3} placeholder="NCP" /></Field>
          <Field label="Direction">
            <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}><option value="out">Money out</option><option value="in">Money in</option><option value="any">Either</option></select>
          </Field>
          <Field label="Post to"><AccountSelect accounts={accounts} value={form.accountCode} onChange={(v) => setForm({ ...form, accountCode: v })} /></Field>
          <Field label="VAT"><VatSelect value={form.vatCode} onChange={(v) => setForm({ ...form, vatCode: v })} /></Field>
          <button className="btn primary" disabled={!form.accountCode}>Add rule</button>
        </form>
      </Card>
    </div>
  );
}

export default function AutomationsPage() {
  const [tab, setTab] = useState("automations");
  const { data, reload } = useApi<Automation[]>("/api/automations");
  const { data: runs, reload: reloadRuns } = useApi<Run[]>("/api/automations/runs?limit=100");
  const { data: outbox } = useApi<Message[]>(tab === "outbox" ? "/api/outbox" : null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [open, setOpen] = useState<string>();

  async function runNow(kind: string) {
    setBusy(kind);
    try { await api(`/api/automations/${kind}/run`, { body: {} }); setError(undefined); await Promise.all([reload(), reloadRuns()]); }
    catch (e) { setError((e as Error).message); } finally { setBusy(undefined); }
  }
  async function toggle(a: Automation, enabled: boolean) {
    try { await api(`/api/automations/${a.kind}`, { method: "PATCH", body: { enabled } }); await reload(); } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="stack">
      <PageHeader title="Automations" subtitle="Work Softilo does on its own, on a schedule. Every run is logged with what it did, and anything that needs judgement is left for a person." />
      <ErrorBanner message={error} />
      <Tabs active={tab} onChange={setTab} tabs={[{ id: "automations", label: "Automations" }, { id: "log", label: "Activity" }, { id: "rules", label: "Bank rules" }, { id: "outbox", label: "Emails sent" }]} />
      {tab === "automations" && (
        <div className="grid-2">
          {data?.map((a) => (
            <Card key={a.kind} title={a.title} actions={<label className="switch"><input type="checkbox" checked={a.enabled} onChange={(e) => void toggle(a, e.target.checked)} aria-label={`${a.title} on`} />{a.enabled ? "On" : "Off"}</label>}>
              <div className="card-pad stack" style={{ gap: 10 }}>
                <p className="muted" style={{ margin: 0 }}>{a.description}</p>
                <div style={{ fontSize: 13 }}>
                  <span className="faint">{every(a.everyMinutes)} · </span>
                  {a.lastRun ? <><span className={`pill ${RUN_TONE[a.lastRun.status]}`}>{RUN_LABEL[a.lastRun.status]}</span> {a.lastRun.summary} <span className="faint">{dateTime(a.lastRun.finished_at)}</span></> : <span className="faint">Not run yet</span>}
                </div>
                <div><button className="btn small" disabled={busy === a.kind} onClick={() => void runNow(a.kind)}>{busy === a.kind ? "Running…" : "Run now"}</button></div>
              </div>
            </Card>
          ))}
        </div>
      )}
      {tab === "log" && (
        <Card>
          {!runs?.length ? <Empty title="No runs yet" /> : (
            <div className="rows">
              {runs.map((r) => (
                <div key={r.id} style={{ padding: "12px 20px", borderTop: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <span><span className={`pill ${RUN_TONE[r.status]}`}>{RUN_LABEL[r.status]}</span> <strong style={{ fontWeight: 500 }}>{data?.find((a) => a.kind === r.kind)?.title ?? r.kind}</strong> · {r.summary}</span>
                    <span className="faint" style={{ fontSize: 12 }}>{dateTime(r.started_at)} · {r.trigger === "manual" ? "run by hand" : "scheduled"}</span>
                  </div>
                  {r.actions.length > 0 && (
                    <>
                      <button className="btn small ghost" style={{ marginTop: 4 }} onClick={() => setOpen(open === r.id ? undefined : r.id)}>{open === r.id ? "Hide" : `Show ${r.actions.length} action${r.actions.length === 1 ? "" : "s"}`}</button>
                      {open === r.id && <ul className="list-plain" style={{ marginTop: 6 }}>{r.actions.map((x, i) => <li key={i}>{x.id && LINK[x.entity] ? <Link href={LINK[x.entity]!(x.id)}>{x.label}</Link> : x.label}</li>)}</ul>}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
      {tab === "rules" && <Rules onError={setError} />}
      {tab === "outbox" && (
        <Card>
          {!outbox ? null : !outbox.length ? <Empty title="No emails yet">Invoices you email and the reminders Softilo sends appear here.</Empty> : (
            <div className="rows">
              {outbox.map((m) => (
                <details key={m.id} style={{ padding: "12px 20px", borderTop: "1px solid var(--border)" }}>
                  <summary style={{ cursor: "pointer" }}>
                    <strong style={{ fontWeight: 500 }}>{m.subject}</strong> <span className="muted">to {m.to_name ?? m.to_address}</span>{" "}
                    <span className={`pill ${m.status === "sent" ? "quiet ok" : "signal"}`}>{m.status === "sent" ? (m.mode === "demo" ? "Kept in outbox (demo)" : "Sent") : m.status}</span>{" "}
                    <small className="faint">{dateTime(m.created_at)} · {m.created_by === "automation" ? "by automation" : "by a person"}</small>
                  </summary>
                  <pre className="doc-preview" style={{ marginTop: 10 }}>{`To: ${m.to_name ? `${m.to_name} <${m.to_address}>` : m.to_address}\nSubject: ${m.subject}\n\n${m.body}`}</pre>
                  {m.error && <p className="warn">{m.error}</p>}
                </details>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
