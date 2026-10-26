"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AccountSelect, useAccounts } from "@/components/pickers";
import { Card, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import { money, sumPence, today } from "@/lib/format";

interface Line { accountCode: string; description: string; debit: string; credit: string }
const blank = (): Line => ({ accountCode: "", description: "", debit: "", credit: "" });

export default function NewJournalPage() {
  const router = useRouter();
  const accounts = useAccounts((a) => !a.is_control);
  const [lines, setLines] = useState<Line[]>([blank(), blank()]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const debits = sumPence(lines.map((l) => l.debit));
  const credits = sumPence(lines.map((l) => l.credit));
  const balanced = debits === credits && debits > 0;
  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    try {
      const { id } = await api("/api/journals", {
        body: {
          date: f.date, memo: f.memo,
          lines: lines.filter((l) => l.accountCode && (Number(l.debit) || Number(l.credit))).map((l) => ({
            accountCode: l.accountCode, description: l.description || undefined, debit: l.debit || "0", credit: l.credit || "0",
          })),
        },
      });
      router.push(`/journals/${id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <PageHeader title="New manual journal" subtitle="For accruals, prepayments, depreciation and corrections. Control accounts (debtors, creditors, stock, VAT) only take postings from their own documents.">
        <button type="button" className="btn ghost" onClick={() => router.back()}>Cancel</button>
        <button className="btn primary" disabled={busy || !balanced}>Post journal</button>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card pad>
        <div className="form-grid">
          <Field label="Date"><input type="date" name="date" defaultValue={today()} required /></Field>
          <Field label="Narrative"><input name="memo" required placeholder="e.g. Accrue October electricity" /></Field>
        </div>
      </Card>
      <Card title="Lines">
        <div className="table-wrap card-pad">
          <table className="lines">
            <thead><tr><th style={{ width: "34%" }}>Account</th><th>Description</th><th>Debit</th><th>Credit</th><th /></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td><AccountSelect accounts={accounts} value={l.accountCode} onChange={(v) => set(i, { accountCode: v })} /></td>
                  <td><input value={l.description} aria-label="Description" onChange={(e) => set(i, { description: e.target.value })} /></td>
                  <td style={{ width: 130 }}><input className="num" inputMode="decimal" aria-label="Debit" value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} /></td>
                  <td style={{ width: 130 }}><input className="num" inputMode="decimal" aria-label="Credit" value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} /></td>
                  <td><button type="button" className="btn ghost small" aria-label="Remove line" disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="btn small" style={{ marginTop: 12 }} onClick={() => setLines((ls) => [...ls, blank()])}>Add line</button>
        </div>
        <div className="totals">
          <span className="muted">Debits</span><span>{money(debits)}</span>
          <span className="muted">Credits</span><span>{money(credits)}</span>
          <span className="grand">{balanced ? "Balanced" : "Difference"}</span>
          <span className="grand" style={balanced ? undefined : { color: "var(--accent-text)" }}>{balanced ? "✓" : money(debits - credits)}</span>
        </div>
      </Card>
    </form>
  );
}
