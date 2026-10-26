"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, Field, Loading, Money, PageHeader, Stat, Status, Tabs } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date, money, sumPence, today } from "@/lib/format";
import type { FeeNote, LedgerRow, MatterDetail } from "@law/lib/types";

const KIND: Record<LedgerRow["kind"], string> = {
  receipt: "Receipt", payment: "Payment", transfer: "Transfer to office", fee_note: "Fee note",
};

function LedgerTable({ rows, empty }: { rows: LedgerRow[]; empty: string }) {
  return (
    <DataTable rows={rows} empty={<Empty title={empty} />}
      columns={[
        { key: "date", label: "Date", render: (r) => date(r.date) },
        { key: "kind", label: "Type", render: (r) => KIND[r.kind] },
        { key: "detail", label: "Details", render: (r) => [r.counterparty, r.reference].filter(Boolean).join(" · ") || "–" },
        { key: "journal", label: "Journal", render: (r) => <span className="mono faint">{r.journal_number}</span> },
        { key: "in", label: "In / billed", num: true, render: (r) => (Number(r.amount) > 0 ? <Money value={r.amount} /> : "") },
        { key: "out", label: "Out / paid", num: true, render: (r) => (Number(r.amount) < 0 ? <Money value={(-Number(r.amount)).toFixed(2)} /> : "") },
        { key: "balance", label: "Balance", num: true, render: (r) => <strong><Money value={r.balance} /></strong> },
      ]} />
  );
}

type Action = "receipt" | "payment" | "time" | "bill";

function ActionForm({ action, detail, onDone }: { action: Action; detail: MatterDetail; onDone: () => Promise<void> }) {
  const id = detail.matter.id;
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const unbilled = detail.time.filter((t) => !t.fee_note_number);
  const unbilledNet = sumPence(unbilled.map((t) => t.value));

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setBusy(true);
    setError(undefined);
    try {
      if (action === "receipt" || action === "payment") {
        await api(`/api/law/matters/${id}/${action}s`, { body: { date: f.date, amount: f.amount, counterparty: f.counterparty, reference: f.reference || undefined } });
      } else if (action === "time") {
        await api(`/api/law/matters/${id}/time`, { body: { date: f.date, minutes: Number(f.minutes), narrative: f.narrative } });
      } else {
        await api(`/api/law/matters/${id}/fee-notes`, { body: { date: f.date } });
      }
      form.reset();
      await onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <ErrorBanner message={error} />
      {(action === "receipt" || action === "payment") && (
        <>
          <p className="muted" style={{ margin: 0 }}>
            {action === "receipt"
              ? "Money received for this client goes into the client bank account, never the office account."
              : <>Client money can only be paid out of what is held for this matter: <strong>{money(detail.clientBalance)}</strong>.</>}
          </p>
          <div className="form-grid">
            <Field label="Date"><input name="date" type="date" defaultValue={today()} required /></Field>
            <Field label="Amount (£)"><input name="amount" inputMode="decimal" required pattern="\d+(\.\d{1,2})?" /></Field>
            <Field label={action === "receipt" ? "Received from" : "Paid to"}><input name="counterparty" required /></Field>
            <Field label="Reference" hint={action === "payment" ? "What the payment is for, e.g. SDLT" : undefined}><input name="reference" /></Field>
          </div>
        </>
      )}
      {action === "time" && (
        <div className="form-grid">
          <Field label="Date"><input name="date" type="date" defaultValue={today()} required /></Field>
          <Field label="Minutes" hint={`Charged in six-minute units at ${money(detail.matter.hourly_rate)} an hour (${detail.matter.fee_earner})`}>
            <input name="minutes" type="number" min={1} max={1440} step={1} required />
          </Field>
          <Field label="Narrative"><input name="narrative" required placeholder="e.g. Review of title and searches" /></Field>
        </div>
      )}
      {action === "bill" && (
        unbilled.length === 0
          ? <Empty title="No unbilled time">Record time on the matter before raising a fee note.</Empty>
          : (
            <>
              <p className="muted" style={{ margin: 0 }}>
                Bill {unbilled.length} time {unbilled.length === 1 ? "entry" : "entries"} for <strong>{money(unbilledNet)}</strong> plus VAT at 20%.
                The fee note is posted to the office ledger; client money can then be transferred to settle it.
              </p>
              <div className="form-grid">
                <Field label="Fee note date"><input name="date" type="date" defaultValue={today()} required /></Field>
              </div>
            </>
          )
      )}
      {!(action === "bill" && unbilled.length === 0) && (
        <div className="actions">
          <button className="btn primary" disabled={busy}>
            {busy ? "Saving…" : { receipt: "Record receipt", payment: "Pay out", time: "Record time", bill: "Raise fee note" }[action]}
          </button>
        </div>
      )}
    </form>
  );
}

function TransferForm({ note, onDone }: { note: FeeNote; onDone: () => Promise<void> }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    setError(undefined);
    try {
      await api(`/api/law/fee-notes/${note.id}/transfer`, { body: { date: f.date, amount: f.amount } });
      await onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" }}>
      {error && <span style={{ color: "var(--accent-text)", fontSize: 13 }} role="alert">{error}</span>}
      <input name="date" type="date" defaultValue={today()} required aria-label="Transfer date" style={{ width: 150 }} />
      <input name="amount" defaultValue={note.maxTransfer} inputMode="decimal" required aria-label="Amount to transfer" style={{ width: 110 }} />
      <button className="btn small" disabled={busy}>Transfer from client</button>
    </form>
  );
}

export default function MatterPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, reload } = useApi<MatterDetail>(`/api/law/matters/${id}`);
  const [action, setAction] = useState<Action>("receipt");

  if (!data) return <div className="stack"><ErrorBanner message={error} />{!error && <div className="card"><Loading /></div>}</div>;
  const m = data.matter;
  const wip = sumPence(data.time.filter((t) => !t.fee_note_number).map((t) => t.value));

  return (
    <div className="stack">
      <PageHeader title={`${m.number} · ${m.description}`}
        subtitle={<>{m.client_name} · {m.fee_earner_name} · opened {date(m.opened_on)} · <Status value={m.status} />
          {m.cdd_status !== "complete" && <> · <span className="pill signal">Due diligence pending</span></>}</>} />
      <ErrorBanner message={error} />
      <div className="grid-3">
        <Stat label="Client account" value={money(data.clientBalance)} sub="Held for this client" />
        <Stat label="Office account" value={money(data.officeBalance)} sub={Number(data.officeBalance) > 0 ? "Billed and not yet paid" : "Nothing owed to the firm"} />
        <Stat label="Unbilled time" value={money(wip)} sub={`${data.time.filter((t) => !t.fee_note_number).length} entries`} />
      </div>
      {m.status === "open" && (
        <div>
          <Tabs active={action} onChange={(a) => setAction(a as Action)} tabs={[
            { id: "receipt", label: "Receive client money" },
            { id: "payment", label: "Pay out client money" },
            { id: "time", label: "Record time" },
            { id: "bill", label: "Raise fee note" },
          ]} />
          <Card pad>
            <ActionForm key={action} action={action} detail={data} onDone={reload} />
          </Card>
        </div>
      )}
      <div className="grid-2">
        <Card title="Client ledger"><LedgerTable rows={data.clientLedger} empty="No client money yet" /></Card>
        <Card title="Office ledger"><LedgerTable rows={data.officeLedger} empty="Nothing billed yet" /></Card>
      </div>
      <Card title="Fee notes">
        <DataTable rows={data.feeNotes} empty={<Empty title="No fee notes yet" />}
          columns={[
            { key: "number", label: "Fee note", render: (r) => <span className="mono" style={{ whiteSpace: "nowrap" }}>{r.number}</span> },
            { key: "date", label: "Date", render: (r) => date(r.date) },
            { key: "net", label: "Fees", num: true, render: (r) => <Money value={r.net} /> },
            { key: "vat", label: "VAT", num: true, render: (r) => <Money value={r.vat} /> },
            { key: "total", label: "Total", num: true, render: (r) => <Money value={r.total} /> },
            { key: "outstanding", label: "Unpaid", num: true, render: (r) => <Money value={r.outstanding} /> },
            { key: "action", label: "", render: (r) => (Number(r.outstanding) === 0 ? <Status value="paid" />
              : Number(r.maxTransfer) > 0 ? <TransferForm note={r} onDone={reload} />
              : <span className="faint">No client money to transfer</span>) },
          ]} />
      </Card>
      <Card title="Time">
        <DataTable rows={data.time} empty={<Empty title="No time recorded yet" />}
          columns={[
            { key: "date", label: "Date", render: (r) => date(r.date) },
            { key: "fe", label: "By", render: (r) => r.fee_earner },
            { key: "narrative", label: "Narrative", render: (r) => r.narrative },
            { key: "minutes", label: "Minutes", num: true, render: (r) => r.minutes },
            { key: "units", label: "Units", num: true, render: (r) => r.units },
            { key: "value", label: "Value", num: true, render: (r) => <Money value={r.value} /> },
            { key: "billed", label: "Billed", render: (r) => (r.fee_note_number ? <span className="mono">{r.fee_note_number}</span> : <span className="pill">Unbilled</span>) },
          ]} />
      </Card>
    </div>
  );
}
