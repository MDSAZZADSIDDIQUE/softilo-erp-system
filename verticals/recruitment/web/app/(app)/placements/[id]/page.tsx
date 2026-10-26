"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, Field, Loading, PageHeader, RecStatus } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { ABSENCE_LABEL, date, ENGAGEMENT_LABEL, money, percent, today } from "@/lib/format";

interface Week { start: string; outcome: string; reason?: string; count: number }
interface Placement {
  id: string; number: string; client_name: string; worker_name: string; engagement: string; ir35_status: string | null;
  consultant_name: string | null; job_title: string; start_date: string; end_date: string | null; status: string;
  holiday_rate: string; on_cost_rate: string; awr_applies: boolean; awr_start: string; sds_received_on: string | null; client_size: string;
  rates: { rateType: string; payRate: string; chargeRate: string }[];
  timesheets: { id: string; number: string; week_ending: string; status: string; hours: string; charge: string; cost: string; margin: string }[];
  absences: { id: string; start_date: string; end_date: string; reason: string }[];
  awr: { status: string; weeksCompleted: number; weeksRemaining: number; qualifiedOn: string | null; projectedQualifyingDate: string | null; weeks: Week[] } | null;
  warnings: string[];
}

const OUTCOME: Record<string, string> = { worked: "Worked", counted_absence: "Counts as worked", paused: "Paused", break: "Break", reset: "Clock reset" };

export default function PlacementPage() {
  const { id } = useParams<{ id: string }>();
  const { data: p, error, reload } = useApi<Placement>(`/api/rec/placements/${id}`);
  const [actionError, setActionError] = useState<string>();

  async function addAbsence(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    try {
      await api(`/api/rec/placements/${id}/absences`, { body: { startDate: f.startDate, endDate: f.endDate, reason: f.reason } });
      form.reset();
      setActionError(undefined);
      await reload();
    } catch (err) { setActionError((err as Error).message); }
  }

  async function end() {
    const endDate = window.prompt("Last day of the placement (YYYY-MM-DD)", today());
    if (!endDate) return;
    try { await api(`/api/rec/placements/${id}/end`, { body: { endDate } }); await reload(); }
    catch (err) { setActionError((err as Error).message); }
  }

  if (!p) return <div className="stack"><ErrorBanner message={error} />{!error && <Loading />}</div>;
  return (
    <div className="stack">
      <PageHeader title={`${p.number} · ${p.worker_name}`} subtitle={<>{p.job_title} at {p.client_name} · <RecStatus value={p.status} /></>}>
        {p.status === "active" && <button className="btn" onClick={end}>End placement</button>}
        {p.status === "active" && <Link className="btn primary" href={`/timesheets/new?placement=${p.id}`}>Enter timesheet</Link>}
      </PageHeader>
      <ErrorBanner message={error ?? actionError} />
      {p.warnings.length > 0 && (
        <div className="banner" role="status"><ul className="warning-list">{p.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>
      )}
      <div className="grid-2">
        <Card title="Terms" pad>
          <div className="form-grid">
            <Field label="Worker"><span>{p.worker_name} · {ENGAGEMENT_LABEL[p.engagement]}{p.ir35_status ? `, ${p.ir35_status} IR35` : ""}</span></Field>
            <Field label="Consultant"><span>{p.consultant_name ?? "–"}</span></Field>
            <Field label="Dates"><span>{date(p.start_date)} – {p.end_date ? date(p.end_date) : "ongoing"}</span></Field>
            <Field label="Client size (off-payroll)"><span>{p.client_size === "small" ? "Small" : "Medium or large"}</span></Field>
            <Field label="Holiday pay accrual"><span>{percent(Number(p.holiday_rate) * 100)}</span></Field>
            <Field label="Employer on-costs"><span>{percent(Number(p.on_cost_rate) * 100)}</span></Field>
            {p.sds_received_on && <Field label="SDS received"><span>{date(p.sds_received_on)}</span></Field>}
          </div>
        </Card>
        <Card title="Rates">
          <DataTable rows={p.rates} columns={[
            { key: "t", label: "Rate", render: (r) => <span style={{ textTransform: "capitalize" }}>{r.rateType}</span> },
            { key: "p", label: "Pay", num: true, render: (r) => money(r.payRate) },
            { key: "c", label: "Charge", num: true, render: (r) => money(r.chargeRate) },
            { key: "m", label: "Spread", num: true, render: (r) => money((Math.round(Number(r.chargeRate) * 10000) - Math.round(Number(r.payRate) * 10000)) / 10000) },
          ]} />
        </Card>
      </div>
      {p.awr ? (
        <Card title="Agency Workers Regulations: 12-week qualifying period" pad>
          <p style={{ marginTop: 0 }}>
            <RecStatus value={p.awr.status} />{" "}
            {p.awr.qualifiedOn
              ? <>Entitled to equal treatment from <strong>{date(p.awr.qualifiedOn)}</strong>.</>
              : <><strong>{p.awr.weeksCompleted}</strong> of 12 weeks completed. {p.awr.projectedQualifyingDate && <>If work continues, qualifies on <strong>{date(p.awr.projectedQualifyingDate)}</strong>.</>}</>}
            <span className="faint"> Clock started {date(p.awr_start)}.</span>
          </p>
          <div className="awr-weeks" aria-label="Weeks of the qualifying period">
            {p.awr.weeks.map((w) => (
              <span key={w.start} className={w.outcome} title={`Week from ${date(w.start)}: ${OUTCOME[w.outcome]}${w.reason ? ` (${ABSENCE_LABEL[w.reason]})` : ""}`}>
                {w.outcome === "worked" || w.outcome === "counted_absence" ? w.count : ""}
              </span>
            ))}
          </div>
          <form className="form-grid" style={{ marginTop: 16 }} onSubmit={addAbsence}>
            <Field label="Absence from"><input name="startDate" type="date" required /></Field>
            <Field label="To"><input name="endDate" type="date" required /></Field>
            <Field label="Reason">
              <select name="reason">{Object.entries(ABSENCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            </Field>
            <div style={{ alignSelf: "end" }}><button className="btn">Record absence</button></div>
          </form>
          {p.absences.length > 0 && (
            <p className="muted">{p.absences.map((a) => `${ABSENCE_LABEL[a.reason]}: ${date(a.start_date)} – ${date(a.end_date)}`).join(" · ")}</p>
          )}
        </Card>
      ) : (
        <Card title="Agency Workers Regulations" pad><p className="muted" style={{ margin: 0 }}>Not tracked: this contractor is treated as outside the AWR.</p></Card>
      )}
      <Card title="Timesheets">
        <DataTable rows={p.timesheets} href={(t) => `/timesheets/${t.id}`}
          empty={<Empty title="No timesheets yet" />}
          columns={[
            { key: "n", label: "Number", render: (t) => <Link href={`/timesheets/${t.id}`}>{t.number}</Link> },
            { key: "w", label: "Week ending", render: (t) => date(t.week_ending) },
            { key: "s", label: "Status", render: (t) => <RecStatus value={t.status} /> },
            { key: "h", label: "Hours", num: true, render: (t) => Number(t.hours).toFixed(2) },
            { key: "c", label: "Charge", num: true, render: (t) => money(t.charge) },
            { key: "k", label: "Cost", num: true, render: (t) => money(t.cost) },
            { key: "m", label: "Margin", num: true, render: (t) => money(t.margin) },
          ]} />
      </Card>
    </div>
  );
}
