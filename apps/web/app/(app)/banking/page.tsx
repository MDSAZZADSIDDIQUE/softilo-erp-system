"use client";

import { Fragment, useState } from "react";
import { AccountSelect, useAccounts, VatSelect } from "@/components/pickers";
import { Card, DataTable, Empty, ErrorBanner, PageHeader, Stat, Status, Tabs } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date, money } from "@/lib/format";

interface BankAccount { code: string; name: string; balance: string; unreconciled: string; statement_balance: string }
interface Txn { id: string; date: string; description: string; reference: string | null; amount: string; status: string; payment_number: string | null; journal_number: string | null }
interface Suggestions {
  payments: { id: string; number: string; date: string; amount: string; contact_name: string }[];
  documents: { id: string; number: string; date: string; outstanding: string; contact_id: string; contact_name: string; type: string }[];
}

function Reconcile({ txn, onDone }: { txn: Txn; onDone: () => void }) {
  const { data: s } = useApi<Suggestions>(`/api/bank/transactions/${txn.id}/suggestions`);
  const accounts = useAccounts((a) => !a.is_control && !a.is_bank);
  const [mode, setMode] = useState<"match" | "code">("match");
  const [account, setAccount] = useState(Number(txn.amount) < 0 ? "7900" : "");
  const [vat, setVat] = useState("EX");
  const [error, setError] = useState<string>();

  async function run(fn: () => Promise<unknown>) {
    try { await fn(); onDone(); } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="card-pad" style={{ background: "var(--surface-sunken)", borderTop: "1px solid var(--border)" }}>
      <Tabs active={mode} onChange={(m) => setMode(m as "match" | "code")} tabs={[{ id: "match", label: "Match" }, { id: "code", label: "Code to account" }]} />
      <ErrorBanner message={error} />
      {mode === "match" ? (
        !s ? <p className="muted">Looking for matches…</p> : !s.payments.length && !s.documents.length ? (
          <p className="muted" style={{ margin: 0 }}>No payment or open document for {money(txn.amount)}. Record the payment first, or code the line to an account.</p>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {s.payments.map((p) => (
              <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <span>Payment <strong style={{ fontWeight: 500 }}>{p.number}</strong> · {p.contact_name} · {date(p.date)} · {money(p.amount)}</span>
                <button className="btn small primary" onClick={() => run(() => api(`/api/bank/transactions/${txn.id}/match`, { body: { paymentId: p.id } }))}>Match</button>
              </div>
            ))}
            {s.documents.map((d) => (
              <div key={d.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <span>{d.type === "sales_invoice" ? "Invoice" : "Bill"} <strong style={{ fontWeight: 500 }}>{d.number}</strong> · {d.contact_name} · {money(d.outstanding)} outstanding</span>
                <button className="btn small primary" onClick={() => run(() => api(`/api/bank/transactions/${txn.id}/payment`, {
                  body: { contactId: d.contact_id, allocations: [{ documentId: d.id, amount: Math.abs(Number(txn.amount)).toFixed(2) }] },
                }))}>Record {d.type === "sales_invoice" ? "receipt" : "payment"} & match</button>
              </div>
            ))}
          </div>
        )
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr auto", gap: 12, alignItems: "center" }}>
          <AccountSelect accounts={accounts} value={account} onChange={setAccount} />
          <VatSelect value={vat} onChange={setVat} />
          <button className="btn primary" disabled={!account} onClick={() => run(() => api(`/api/bank/transactions/${txn.id}/post`, { body: { accountCode: account, vatCode: vat } }))}>Post</button>
        </div>
      )}
    </div>
  );
}

export default function BankingPage() {
  const { data: accounts, reload: reloadAccounts } = useApi<BankAccount[]>("/api/bank-accounts");
  const [code, setCode] = useState("1200");
  const [status, setStatus] = useState("unreconciled");
  const { data: txns, error, reload } = useApi<Txn[]>(`/api/bank/transactions?account=${code}&status=${status}`);
  const [open, setOpen] = useState<string>();
  const [importMsg, setImportMsg] = useState<string>();
  const [importError, setImportError] = useState<string>();
  const current = accounts?.find((a) => a.code === code);

  async function importFile(file: File) {
    setImportError(undefined);
    try {
      const r = await api<{ lines: number; imported: number; duplicates: number }>("/api/bank/import", { body: { bankAccountCode: code, content: await file.text() } });
      setImportMsg(`Imported ${r.imported} of ${r.lines} lines${r.duplicates ? ` (${r.duplicates} already imported)` : ""}.`);
      await Promise.all([reload(), reloadAccounts()]);
    } catch (e) {
      setImportError((e as Error).message);
    }
  }

  const done = async () => { setOpen(undefined); await Promise.all([reload(), reloadAccounts()]); };

  return (
    <div className="stack">
      <PageHeader title="Bank reconciliation" subtitle="Import your statement, then match each line to a payment or code it to an account.">
        <select value={code} onChange={(e) => setCode(e.target.value)} aria-label="Bank account" style={{ width: "auto" }}>
          {accounts?.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
        </select>
        <label className="btn primary">
          Import statement (CSV)
          <input type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ""; }} />
        </label>
      </PageHeader>
      {importMsg && <div className="banner ok">{importMsg}</div>}
      <ErrorBanner message={importError ?? error} />
      {current && (
        <div className="grid-3">
          <Stat label="Balance in Softilo" value={money(current.balance)} />
          <Stat label="Statement lines imported" value={money(current.statement_balance)} sub="Sum of imported lines" />
          <Stat label="To reconcile" value={current.unreconciled} alert={Number(current.unreconciled) > 0} />
        </div>
      )}
      <Card>
        <div className="card-pad" style={{ paddingBottom: 0 }}>
          <Tabs active={status} onChange={setStatus} tabs={[{ id: "unreconciled", label: "To reconcile" }, { id: "reconciled", label: "Reconciled" }]} />
        </div>
        {!txns ? null : !txns.length ? (
          <Empty title={status === "unreconciled" ? "All caught up" : "Nothing reconciled yet"}>
            {status === "unreconciled" && "Import a CSV with Date, Description and Amount (or Paid in / Paid out) columns."}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Date</th><th>Description</th><th>Reference</th><th className="num">Money in</th><th className="num">Money out</th><th>Status</th><th /></tr></thead>
              <tbody>
                {txns.map((t) => (
                  <Fragment key={t.id}>
                    <tr>
                      <td>{date(t.date)}</td><td>{t.description}</td><td>{t.reference ?? <span className="faint">–</span>}</td>
                      <td className="num">{Number(t.amount) > 0 ? money(t.amount) : ""}</td>
                      <td className="num">{Number(t.amount) < 0 ? money(-Number(t.amount)) : ""}</td>
                      <td><Status value={t.status} /> {t.payment_number ?? t.journal_number ? <span className="faint">{t.payment_number ?? t.journal_number}</span> : null}</td>
                      <td className="num">{t.status === "unreconciled" && <button className="btn small" onClick={() => setOpen(open === t.id ? undefined : t.id)}>{open === t.id ? "Close" : "Reconcile"}</button>}</td>
                    </tr>
                    {open === t.id && <tr><td colSpan={7} style={{ padding: 0 }}><Reconcile txn={t} onDone={done} /></td></tr>}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
