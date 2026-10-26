"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { fromEntries, HoursGrid, toEntries, type HoursMap } from "@/components/hours-grid";
import { Card, DataTable, ErrorBanner, Field, Loading, PageHeader, RecStatus } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date, dateTime, money } from "@/lib/format";

interface Timesheet {
  id: string; number: string; week_ending: string; status: string; hours: string; pay: string; holiday: string; on_costs: string;
  charge: string; cost: string; margin: string; approved_by: string | null; approved_at: string | null; rejected_reason: string | null;
  invoice_id: string | null; invoice_number: string | null; accrual_number: string | null;
  placement_id: string; placement_number: string; worker_name: string; client_name: string; job_title: string;
  entries: { date: string; rate_type: string; hours: string }[];
  rates: { rate_type: string; hours?: string; pay_rate: string; charge_rate: string; pay?: string; charge?: string }[];
}

export default function TimesheetPage() {
  const { id } = useParams<{ id: string }>();
  const { data: t, error, reload } = useApi<Timesheet>(`/api/rec/timesheets/${id}`);
  const [hours, setHours] = useState<HoursMap>({});
  const [approver, setApprover] = useState("");
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (t) setHours(fromEntries(t.entries)); }, [t]);

  async function act(path: string, body: unknown = {}, method = "POST") {
    setBusy(true);
    try {
      await api(`/api/rec/timesheets/${id}${path}`, { method, body });
      setActionError(undefined);
      await reload();
    } catch (err) { setActionError((err as Error).message); }
    setBusy(false);
  }

  if (!t) return <div className="stack"><ErrorBanner message={error} />{!error && <Loading />}</div>;
  const editable = t.status === "draft" || t.status === "rejected";
  return (
    <div className="stack">
      <PageHeader title={`${t.number} · week ending ${date(t.week_ending)}`}
        subtitle={<><Link href={`/placements/${t.placement_id}`}>{t.placement_number}</Link> · {t.worker_name}, {t.job_title} at {t.client_name} · <RecStatus value={t.status} /></>}>
        {editable && <button className="btn" disabled={busy} onClick={() => act("", { entries: toEntries(hours) }, "PUT")}>Save</button>}
        {editable && <button className="btn primary" disabled={busy} onClick={() => act("", { entries: toEntries(hours), submit: true }, "PUT")}>Submit for approval</button>}
        {t.invoice_id && <Link className="btn" href={`/invoices/${t.invoice_id}`}>Invoice {t.invoice_number}</Link>}
      </PageHeader>
      <ErrorBanner message={error ?? actionError} />
      {t.status === "rejected" && t.rejected_reason && <div className="banner error">Rejected by the client: {t.rejected_reason}</div>}
      <Card title="Hours">
        <HoursGrid weekEnding={t.week_ending} rateTypes={t.rates.map((r) => r.rate_type)} hours={hours} onChange={setHours} readOnly={!editable} />
      </Card>
      {t.status === "submitted" && (
        <Card title="Client approval" pad>
          <div className="form-grid">
            <Field label="Approved by" hint="Name of the person at the client who signed off the hours">
              <input value={approver} onChange={(e) => setApprover(e.target.value)} placeholder="e.g. Dana Reid, Shift manager" />
            </Field>
            <div style={{ alignSelf: "end", display: "flex", gap: 8 }}>
              <button className="btn primary" disabled={busy || !approver.trim()} onClick={() => act("/approve", { approvedBy: approver })}>Approve and accrue pay</button>
              <button className="btn" disabled={busy} onClick={() => {
                const reason = window.prompt("Why is the timesheet being rejected?");
                if (reason) void act("/reject", { reason });
              }}>Reject</button>
            </div>
          </div>
        </Card>
      )}
      <div className="grid-2">
        <Card title="Rates">
          <DataTable rows={t.rates} columns={[
            { key: "t", label: "Rate", render: (r) => <span style={{ textTransform: "capitalize" }}>{r.rate_type}</span> },
            { key: "h", label: "Hours", num: true, render: (r) => (r.hours ? Number(r.hours).toFixed(2) : "–") },
            { key: "p", label: "Pay rate", num: true, render: (r) => money(r.pay_rate) },
            { key: "c", label: "Charge rate", num: true, render: (r) => money(r.charge_rate) },
          ]} />
        </Card>
        <Card title="Charge, cost and margin" pad>
          <table className="totals" style={{ width: "100%" }}>
            <tbody>
              <tr><td>Charge to client (net of VAT)</td><td className="num">{money(t.charge)}</td></tr>
              <tr><td>Worker pay</td><td className="num">{money(t.pay)}</td></tr>
              <tr><td>Holiday pay accrued</td><td className="num">{money(t.holiday)}</td></tr>
              <tr><td>Employer on-costs</td><td className="num">{money(t.on_costs)}</td></tr>
              <tr><td><strong>Gross margin</strong></td><td className="num"><strong>{money(t.margin)}</strong></td></tr>
            </tbody>
          </table>
          {t.approved_by && (
            <p className="muted" style={{ marginBottom: 0 }}>
              Approved by {t.approved_by} on {dateTime(t.approved_at)}. Pay accrued in journal {t.accrual_number}.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
