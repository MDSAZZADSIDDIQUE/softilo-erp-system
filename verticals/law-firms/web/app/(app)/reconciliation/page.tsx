"use client";

import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, Field, Money, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date, dateTime, today } from "@/lib/format";

interface Item { reference: string; amount: string }

interface Result {
  id?: string;
  statementDate: string;
  statementBalance: string;
  outstandingLodgements: string;
  unpresentedPayments: string;
  adjustedBank: string;
  cashBook: string;
  clientLedgers: string;
  clientControl: string;
  differences: { bankVsCashBook: string; cashBookVsLedgers: string; ledgersVsControl: string };
  overdrawn: string[];
  balanced: boolean;
  matters: { id: string; number: string; description: string; client_name: string; balance: string }[];
  nextDue: string;
}

interface Saved {
  id: string;
  statement_date: string;
  statement_balance: string;
  adjusted_bank: string;
  cash_book: string;
  client_ledgers: string;
  balanced: boolean;
  prepared_by_name: string;
  prepared_at: string;
  signed_off_by_name: string | null;
  signed_off_at: string | null;
  sign_off_note: string | null;
}

function ItemList({ label, hint, items, onChange }: { label: string; hint: string; items: Item[]; onChange: (items: Item[]) => void }) {
  const set = (i: number, patch: Partial<Item>) => onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div><strong>{label}</strong> <span className="faint" style={{ fontSize: 13 }}>{hint}</span></div>
      {items.map((it, i) => (
        <div key={i} style={{ display: "flex", gap: 8 }}>
          <input aria-label={`${label} reference`} placeholder="Reference" value={it.reference} onChange={(e) => set(i, { reference: e.target.value })} style={{ flex: 2 }} />
          <input aria-label={`${label} amount`} placeholder="0.00" inputMode="decimal" value={it.amount} onChange={(e) => set(i, { amount: e.target.value })} style={{ flex: 1 }} />
          <button type="button" className="btn small ghost" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="Remove">Remove</button>
        </div>
      ))}
      <div><button type="button" className="btn small" onClick={() => onChange([...items, { reference: "", amount: "" }])}>Add item</button></div>
    </div>
  );
}

function Line({ label, value, strong, diff }: { label: string; value: string; strong?: boolean; diff?: boolean }) {
  const bad = diff && Number(value) !== 0;
  return (
    <tr>
      <td style={{ fontWeight: strong ? 500 : undefined }}>{label}</td>
      <td className="num" style={{ fontWeight: strong ? 500 : undefined, color: bad ? "var(--accent-text)" : undefined }}>
        {diff && !bad ? "✓ Agrees" : <Money value={value} />}
      </td>
    </tr>
  );
}

function ResultView({ r }: { r: Result }) {
  return (
    <div className="stack">
      <div className={`banner${r.balanced ? "" : " error"}`} role="status">
        {r.balanced
          ? <>The client account reconciles at {date(r.statementDate)}. Next reconciliation due by <strong>{date(r.nextDue)}</strong>.</>
          : <>The client account does not reconcile at {date(r.statementDate)}. Investigate the differences below promptly (SRA Accounts Rules, rule 8.3).</>}
      </div>
      <div className="grid-3">
        <Card title="1. Bank">
          <table className="data"><tbody>
            <Line label="Statement balance" value={r.statementBalance} />
            <Line label="Add: outstanding lodgements" value={r.outstandingLodgements} />
            <Line label="Less: unpresented payments" value={r.unpresentedPayments} />
            <Line label="Adjusted bank balance" value={r.adjustedBank} strong />
          </tbody></table>
        </Card>
        <Card title="2. Client cash book">
          <table className="data"><tbody>
            <Line label="Client bank account (1250)" value={r.cashBook} strong />
            <Line label="Difference to adjusted bank" value={r.differences.bankVsCashBook} diff />
          </tbody></table>
        </Card>
        <Card title="3. Client ledgers">
          <table className="data"><tbody>
            <Line label="Total of client matter ledgers" value={r.clientLedgers} strong />
            <Line label="Difference to cash book" value={r.differences.cashBookVsLedgers} diff />
            <Line label="Difference to client money held (2300)" value={r.differences.ledgersVsControl} diff />
          </tbody></table>
        </Card>
      </div>
      {r.overdrawn.length > 0 && (
        <div className="banner error" role="alert">{r.overdrawn.length} client {r.overdrawn.length === 1 ? "ledger is" : "ledgers are"} overdrawn. Replace the shortfall from office money immediately (rule 6.1).</div>
      )}
      <Card title="List of client balances">
        <DataTable rows={r.matters} href={(m) => `/matters/${m.id}`} empty={<Empty title="No client money held at this date" />}
          columns={[
            { key: "number", label: "Matter", render: (m) => <span className="mono" style={{ whiteSpace: "nowrap" }}>{m.number}</span> },
            { key: "client", label: "Client", render: (m) => m.client_name },
            { key: "description", label: "Description", render: (m) => m.description },
            { key: "balance", label: "Balance", num: true, render: (m) => <Money value={m.balance} /> },
          ]} />
      </Card>
    </div>
  );
}

export default function ReconciliationPage() {
  const { data: history, reload } = useApi<{ rows: Saved[]; nextDue: string | null }>("/api/law/reconciliations");
  const [statementDate, setStatementDate] = useState(today());
  const [statementBalance, setStatementBalance] = useState("");
  const [lodgements, setLodgements] = useState<Item[]>([]);
  const [unpresented, setUnpresented] = useState<Item[]>([]);
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const body = () => ({
    statementDate, statementBalance,
    outstandingLodgements: lodgements.filter((i) => i.amount),
    unpresentedPayments: unpresented.filter((i) => i.amount),
  });

  async function run(save: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await api<Result>(save ? "/api/law/reconciliations" : "/api/law/reconciliations/preview", { body: body() }));
      if (save) await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function signOff(rec: Saved) {
    const note = rec.balanced ? undefined : window.prompt("This reconciliation does not balance. Note the differences and what is being done:") ?? undefined;
    if (!rec.balanced && !note) return;
    try {
      await api(`/api/law/reconciliations/${rec.id}/sign-off`, { body: { note } });
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const overdue = history?.nextDue && history.nextDue < today();

  return (
    <div className="stack">
      <PageHeader title="Three-way reconciliation"
        subtitle={history?.nextDue
          ? <>Bank statement, client cash book and client ledgers, at least every five weeks. Next due by <strong style={{ color: overdue ? "var(--accent-text)" : undefined }}>{date(history.nextDue)}</strong>{overdue ? " (overdue)" : ""}.</>
          : "Bank statement, client cash book and client ledgers, at least every five weeks."} />
      <ErrorBanner message={error} />
      <Card title="Client bank statement" pad>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(false); }}>
          <div className="form-grid">
            <Field label="Statement date"><input type="date" value={statementDate} onChange={(e) => setStatementDate(e.target.value)} required /></Field>
            <Field label="Statement closing balance (£)"><input inputMode="decimal" value={statementBalance} onChange={(e) => setStatementBalance(e.target.value)} required pattern="-?\d+(\.\d{1,2})?" /></Field>
          </div>
          <div className="grid-2">
            <ItemList label="Outstanding lodgements" hint="In the cash book, not yet on the statement" items={lodgements} onChange={setLodgements} />
            <ItemList label="Unpresented payments" hint="Paid out in the cash book, not yet on the statement" items={unpresented} onChange={setUnpresented} />
          </div>
          <div className="actions">
            <button className="btn" disabled={busy}>Check</button>
            <button type="button" className="btn primary" disabled={busy || !statementBalance} onClick={() => void run(true)}>Save for sign-off</button>
          </div>
        </form>
      </Card>
      {result && <ResultView r={result} />}
      <Card title="Reconciliation history">
        <DataTable rows={history?.rows}
          empty={<Empty title="No reconciliations yet">Save one above. The COFA or a manager then signs it off.</Empty>}
          columns={[
            { key: "date", label: "Statement date", render: (r) => date(r.statement_date) },
            { key: "statement", label: "Statement", num: true, render: (r) => <Money value={r.statement_balance} /> },
            { key: "cash", label: "Cash book", num: true, render: (r) => <Money value={r.cash_book} /> },
            { key: "ledgers", label: "Client ledgers", num: true, render: (r) => <Money value={r.client_ledgers} /> },
            { key: "result", label: "Result", render: (r) => <span className={`pill ${r.balanced ? "quiet ok" : "signal"}`}>{r.balanced ? "Reconciled" : "Differences"}</span> },
            { key: "prepared", label: "Prepared", render: (r) => <>{r.prepared_by_name}<div className="faint" style={{ fontSize: 12 }}>{dateTime(r.prepared_at)}</div></> },
            { key: "signoff", label: "Signed off", render: (r) => (r.signed_off_at
              ? <>{r.signed_off_by_name}<div className="faint" style={{ fontSize: 12 }}>{dateTime(r.signed_off_at)}{r.sign_off_note ? ` · ${r.sign_off_note}` : ""}</div></>
              : <button className="btn small primary" onClick={() => void signOff(r)}>Sign off</button>) },
          ]} />
      </Card>
      <p className="faint" style={{ fontSize: 13 }}>Signed-off reconciliations are permanent. They are kept for the firm&apos;s accountant&apos;s report.</p>
    </div>
  );
}
