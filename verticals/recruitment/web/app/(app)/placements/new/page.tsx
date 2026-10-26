"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Card, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { ENGAGEMENT_LABEL, money, today } from "@/lib/format";

interface Option { id: string; name: string }
interface Worker extends Option { engagement: string; ir35_status: string | null; kid_issued_on: string | null }
interface Client extends Option { client_size: string }
interface Rate { rateType: string; payRate: string; chargeRate: string }

export default function NewPlacementPage() {
  const router = useRouter();
  const params = useSearchParams();
  const workers = useApi<Worker[]>("/api/rec/workers").data ?? [];
  const clients = useApi<Client[]>("/api/rec/clients").data ?? [];
  const consultants = useApi<Option[]>("/api/rec/consultants").data ?? [];
  const [workerId, setWorkerId] = useState(params.get("worker") ?? "");
  const [clientId, setClientId] = useState(params.get("client") ?? "");
  const [rates, setRates] = useState<Rate[]>([{ rateType: "standard", payRate: "", chargeRate: "" }]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const worker = workers.find((w) => w.id === workerId);
  const client = clients.find((c) => c.id === clientId);
  const needsSds = worker?.engagement === "ltd" && client?.client_size === "medium_large";

  const setRate = (i: number, patch: Partial<Rate>) => setRates((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    try {
      const pct = (v: string | undefined) => (v ? (Number(v) / 100).toFixed(4) : undefined);
      const r = await api<{ id: string; warnings: string[] }>("/api/rec/placements", {
        body: {
          clientId, workerId, consultantId: f.consultantId || undefined, jobTitle: f.jobTitle,
          startDate: f.startDate, endDate: f.endDate || undefined, sdsReceivedOn: f.sdsReceivedOn || undefined,
          holidayRate: pct(f.holidayRate), onCostRate: pct(f.onCostRate), awrStart: f.awrStart || undefined,
          rates: rates.filter((x) => x.rateType && x.payRate !== "").map((x) => ({ ...x, rateType: x.rateType.trim().toLowerCase() })),
        },
      });
      router.push(`/placements/${r.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <PageHeader title="New placement">
        <button type="button" className="btn ghost" onClick={() => router.back()}>Cancel</button>
        <button className="btn primary" disabled={busy || !workerId || !clientId}>Create placement</button>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card title="Assignment" pad>
        <div className="form-grid">
          <Field label="Worker" hint={worker ? `${ENGAGEMENT_LABEL[worker.engagement]}${worker.ir35_status ? `, ${worker.ir35_status} IR35` : ""}${worker.engagement !== "ltd" && !worker.kid_issued_on ? " · no Key Information Document yet" : ""}` : undefined}>
            <select value={workerId} onChange={(e) => setWorkerId(e.target.value)} required>
              <option value="">Choose…</option>
              {workers.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </Field>
          <Field label="Client" hint={client ? (client.client_size === "small" ? "Small client: the contractor decides IR35 status" : "Medium or large client: the client decides IR35 status") : undefined}>
            <select value={clientId} onChange={(e) => setClientId(e.target.value)} required>
              <option value="">Choose…</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Job title"><input name="jobTitle" required /></Field>
          <Field label="Consultant">
            <select name="consultantId" defaultValue="">
              <option value="">None</option>
              {consultants.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Start date"><input name="startDate" type="date" defaultValue={today()} required /></Field>
          <Field label="End date" hint="Leave blank if ongoing"><input name="endDate" type="date" /></Field>
          {needsSds && <Field label="Status Determination Statement received"><input name="sdsReceivedOn" type="date" required /></Field>}
        </div>
      </Card>
      <Card title="Pay and charge rates (per hour or per day)" pad>
        <table className="hours-grid">
          <thead><tr><th>Rate type</th><th>Pay rate (£)</th><th>Charge rate (£)</th><th className="num">Margin</th><th /></tr></thead>
          <tbody>
            {rates.map((r, i) => (
              <tr key={i}>
                <td><input value={r.rateType} onChange={(e) => setRate(i, { rateType: e.target.value })} style={{ width: 140 }} required /></td>
                <td><input value={r.payRate} inputMode="decimal" onChange={(e) => setRate(i, { payRate: e.target.value })} required /></td>
                <td><input value={r.chargeRate} inputMode="decimal" onChange={(e) => setRate(i, { chargeRate: e.target.value })} required /></td>
                <td className="num">{r.payRate && r.chargeRate ? money(Math.round((Number(r.chargeRate) - Number(r.payRate)) * 100) / 100) : "–"}</td>
                <td>{rates.length > 1 && <button type="button" className="btn ghost" onClick={() => setRates((rs) => rs.filter((_, j) => j !== i))}>Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="btn" style={{ marginTop: 12 }}
          onClick={() => setRates((rs) => [...rs, { rateType: rs.length === 1 ? "overtime" : "", payRate: "", chargeRate: "" }])}>Add rate</button>
      </Card>
      <Card title="Costs and AWR" pad>
        <div className="form-grid">
          <Field label="Holiday pay accrual (%)" hint="Defaults to 12.07% rolled-up holiday pay for PAYE workers, 0% otherwise">
            <input name="holidayRate" inputMode="decimal" placeholder={worker?.engagement === "paye" ? "12.07" : "0"} />
          </Field>
          <Field label="Employer on-costs (%)" hint="Estimate of employer NI, pension and levy on PAYE pay"><input name="onCostRate" inputMode="decimal" placeholder="0" /></Field>
          <Field label="AWR clock start" hint="Earlier date if the worker already did this role for this client"><input name="awrStart" type="date" /></Field>
        </div>
      </Card>
    </form>
  );
}
