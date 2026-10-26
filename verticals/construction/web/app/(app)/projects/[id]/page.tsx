"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { CATEGORY_LABELS, CisPill, Meter, percent, stageLabel } from "@/components/cons";
import { Card, DataTable, Empty, ErrorBanner, Field, Loading, PageHeader, Stat, Tabs } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date, money, today } from "@/lib/format";

interface Detail {
  id: string; code: string; name: string; customer_name: string; site_address: string | null; contract_sum: string; retention_rate: string;
  vat_rate: string; end_user_notice: boolean; customer_cis_registered: boolean; due_days: number; final_days: number; pay_less_days: number;
  summary: { contractValue: string; budgetTotal: string; costToDate: string; valuedToDate: string; marginToDate: string; budgetedMargin: string;
    categories: { category: string; budget: string; actual: string; remaining: string; usedPercent: string | null }[] };
  variations: { id: string; number: string; description: string; amount: string; status: string; date: string }[];
  applications: { id: string; reference: string; stage: string; date: string; gross_to_date: string; retention_to_date: string; amount_due: string; vat_code: string; total: string; final_date: string; pay_less_by: string; outstanding: string }[];
  bills: { id: string; number: string; supplier_ref: string; date: string; supplier_name: string; gross: string; deduction: string; cis_status: string | null; total: string; outstanding: string }[];
}

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const { data: p, error, reload } = useApi<Detail>(`/api/construction/projects/${id}`);
  const [tab, setTab] = useState("costs");
  if (!p) return <div className="stack"><ErrorBanner message={error} />{!error && <Loading rows={6} />}</div>;
  const s = p.summary;
  return (
    <div className="stack">
      <PageHeader title={`${p.code} · ${p.name}`} subtitle={<>{p.customer_name}{p.site_address ? ` · ${p.site_address}` : ""} · retention {percent(p.retention_rate)}</>}>
        <Link className="btn" href={`/bills/new?projectId=${p.id}`}>Enter job bill</Link>
      </PageHeader>
      <div className="grid-4">
        <Stat label="Contract value" value={money(s.contractValue)} sub={`Contract sum ${money(p.contract_sum)} plus approved variations`} />
        <Stat label="Cost to date" value={money(s.costToDate)} sub={`Budget ${money(s.budgetTotal)}`} />
        <Stat label="Valued to date" value={money(s.valuedToDate)} sub={`${p.applications.length} application${p.applications.length === 1 ? "" : "s"}`} />
        <Stat label="Margin to date" value={money(s.marginToDate)} sub={`Budgeted margin ${money(s.budgetedMargin)}`} alert={Number(s.marginToDate) < 0} />
      </div>
      <Tabs active={tab} onChange={setTab} tabs={[
        { id: "costs", label: "Budget and cost" },
        { id: "applications", label: "Applications for payment" },
        { id: "variations", label: "Variations" },
        { id: "bills", label: "Job bills" },
      ]} />
      {tab === "costs" && (
        <Card>
          <DataTable rows={s.categories}
            columns={[
              { key: "c", label: "Category", render: (c) => CATEGORY_LABELS[c.category] },
              { key: "b", label: "Budget", num: true, render: (c) => money(c.budget) },
              { key: "a", label: "Actual", num: true, render: (c) => money(c.actual) },
              { key: "r", label: "Remaining", num: true, render: (c) => money(c.remaining) },
              { key: "u", label: "Used", render: (c) => <Meter used={c.usedPercent} /> },
            ]}
            footer={<tr><td>Total</td><td className="num">{money(s.budgetTotal)}</td><td className="num">{money(s.costToDate)}</td><td className="num">{money(Number(s.budgetTotal) - Number(s.costToDate))}</td><td /></tr>} />
        </Card>
      )}
      {tab === "applications" && <Applications p={p} onDone={reload} />}
      {tab === "variations" && <Variations p={p} onDone={reload} />}
      {tab === "bills" && (
        <Card>
          <DataTable rows={p.bills} href={(b) => `/bills?highlight=${b.id}`}
            empty={<Empty title="No bills on this project yet"><Link href={`/bills/new?projectId=${p.id}`}>Enter a job bill</Link></Empty>}
            columns={[
              { key: "n", label: "Number", render: (b) => b.number },
              { key: "s", label: "Supplier", render: (b) => b.supplier_name },
              { key: "r", label: "Their ref", render: (b) => b.supplier_ref },
              { key: "d", label: "Date", render: (b) => date(b.date) },
              { key: "c", label: "CIS", render: (b) => <CisPill status={b.cis_status} /> },
              { key: "g", label: "Net of VAT", num: true, render: (b) => money(b.gross) },
              { key: "x", label: "CIS deducted", num: true, render: (b) => money(b.deduction) },
              { key: "o", label: "Outstanding", num: true, render: (b) => money(b.outstanding) },
            ]} />
        </Card>
      )}
    </div>
  );
}

function Applications({ p, onDone }: { p: Detail; onDone: () => void }) {
  const last = p.applications.at(-1);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<{ reference: string; vatReason: string; total: string; finalDate: string; payLessNoticeBy: string }>();
  const [busy, setBusy] = useState(false);
  const done = last?.stage === "final";

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    setError(undefined);
    try {
      setResult(await api(`/api/construction/projects/${p.id}/applications`, { body: f }));
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <Card>
        <DataTable rows={p.applications} href={(a) => `/applications/${a.id}`}
          empty={<Empty title="No applications yet">Value the work done to date below.</Empty>}
          columns={[
            { key: "r", label: "Reference", render: (a) => <Link href={`/applications/${a.id}`}>{a.reference}</Link> },
            { key: "s", label: "Stage", render: (a) => stageLabel(a.stage) },
            { key: "d", label: "Date", render: (a) => date(a.date) },
            { key: "g", label: "Gross to date", num: true, render: (a) => money(a.gross_to_date) },
            { key: "ret", label: "Retention", num: true, render: (a) => money(a.retention_to_date) },
            { key: "due", label: "Amount due", num: true, render: (a) => money(a.amount_due) },
            { key: "v", label: "VAT", render: (a) => a.vat_code === "RC20" ? <span className="pill">Reverse charge</span> : a.vat_code },
            { key: "f", label: "Final date", render: (a) => <span className="deadline">{date(a.final_date)}<small>Pay-less by {date(a.pay_less_by)}</small></span> },
            { key: "o", label: "Outstanding", num: true, render: (a) => money(a.outstanding) },
          ]} />
      </Card>
      {!done && (
        <Card title="New application for payment" pad>
          <form className="stack" style={{ gap: 16 }} onSubmit={submit}>
            <ErrorBanner message={error} />
            {result && (
              <div className="banner ok" role="status">
                {result.reference} posted for {money(result.total)}. {result.vatReason}. Final date for payment {date(result.finalDate)}; a pay-less notice must arrive by {date(result.payLessNoticeBy)}.
              </div>
            )}
            <div className="form-grid">
              <Field label="Gross valuation to date (£)" hint={last ? `Last application: ${money(last.gross_to_date)}` : "Cumulative value of work, including variations"}>
                <input name="grossToDate" className="num" inputMode="decimal" required />
              </Field>
              <Field label="Valuation period ends"><input name="periodEnd" type="date" defaultValue={today()} required /></Field>
              <Field label="Application date"><input name="date" type="date" defaultValue={today()} required /></Field>
              <Field label="Stage" hint="Practical completion releases half the retention; the final account releases the rest">
                <select name="stage" defaultValue="interim">
                  <option value="interim">Interim</option>
                  <option value="practical_completion">Practical completion</option>
                  <option value="final">Final account</option>
                </select>
              </Field>
            </div>
            <div><button className="btn primary" disabled={busy}>{busy ? "Posting…" : "Post application"}</button></div>
          </form>
        </Card>
      )}
    </div>
  );
}

function Variations({ p, onDone }: { p: Detail; onDone: () => void }) {
  const [error, setError] = useState<string>();
  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form));
    await act(() => api(`/api/construction/projects/${p.id}/variations`, { body: f }));
    form.reset();
  }
  return (
    <div className="stack">
      <ErrorBanner message={error} />
      <Card>
        <DataTable rows={p.variations} empty={<Empty title="No variations yet" />}
          columns={[
            { key: "n", label: "Number", render: (v) => v.number },
            { key: "d", label: "Date", render: (v) => date(v.date) },
            { key: "x", label: "Description", render: (v) => v.description },
            { key: "s", label: "Status", render: (v) => <span className={`pill ${v.status === "approved" ? "quiet ok" : v.status === "pending" ? "signal" : "quiet"}`}>{v.status === "pending" ? "Awaiting instruction" : v.status === "approved" ? "Approved" : "Rejected"}</span> },
            { key: "a", label: "Amount", num: true, render: (v) => money(v.amount) },
            { key: "act", label: "", render: (v) => v.status === "pending" ? (
              <span className="actions">
                <button className="btn small" onClick={() => act(() => api(`/api/construction/variations/${v.id}/approve`, { method: "POST" }))}>Approve</button>
                <button className="btn ghost small" onClick={() => act(() => api(`/api/construction/variations/${v.id}/reject`, { method: "POST" }))}>Reject</button>
              </span>
            ) : null },
          ]} />
      </Card>
      <Card title="Record a variation" pad>
        <form className="form-grid" onSubmit={submit}>
          <Field label="Description"><input name="description" required /></Field>
          <Field label="Amount (£)" hint="Negative for an omission"><input name="amount" className="num" inputMode="decimal" required /></Field>
          <Field label="Date"><input name="date" type="date" defaultValue={today()} required /></Field>
          <div style={{ alignSelf: "end" }}><button className="btn">Add variation</button></div>
        </form>
      </Card>
    </div>
  );
}
