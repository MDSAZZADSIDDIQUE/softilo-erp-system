"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { HoursGrid, toEntries, type HoursMap } from "@/components/hours-grid";
import { Card, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { lastSunday, today } from "@/lib/format";

interface PlacementOption { id: string; number: string; worker_name: string; client_name: string; status: string }
interface PlacementDetail { rates: { rateType: string }[] }

export default function NewTimesheetPage() {
  const router = useRouter();
  const placements = (useApi<PlacementOption[]>("/api/rec/placements").data ?? []).filter((p) => p.status === "active");
  const [placementId, setPlacementId] = useState(useSearchParams().get("placement") ?? "");
  const { data: placement } = useApi<PlacementDetail>(placementId ? `/api/rec/placements/${placementId}` : null);
  const [weekEnding, setWeekEnding] = useState(lastSunday(today()));
  const [hours, setHours] = useState<HoursMap>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function save(submit: boolean) {
    setBusy(true);
    try {
      const r = await api<{ id: string }>("/api/rec/timesheets", { body: { placementId, weekEnding, submit, entries: toEntries(hours) } });
      router.push(`/timesheets/${r.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PageHeader title="Enter timesheet">
        <button type="button" className="btn ghost" onClick={() => router.back()}>Cancel</button>
        <button className="btn" disabled={busy || !placementId} onClick={() => save(false)}>Save draft</button>
        <button className="btn primary" disabled={busy || !placementId} onClick={() => save(true)}>Submit for approval</button>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card pad>
        <div className="form-grid">
          <Field label="Placement">
            <select value={placementId} onChange={(e) => setPlacementId(e.target.value)}>
              <option value="">Choose…</option>
              {placements.map((p) => <option key={p.id} value={p.id}>{p.number} · {p.worker_name} at {p.client_name}</option>)}
            </select>
          </Field>
          <Field label="Week ending"><input type="date" value={weekEnding} onChange={(e) => { setWeekEnding(e.target.value); setHours({}); }} /></Field>
        </div>
      </Card>
      {placement && (
        <Card title="Hours worked">
          <HoursGrid weekEnding={weekEnding} rateTypes={placement.rates.map((r) => r.rateType)} hours={hours} onChange={setHours} />
        </Card>
      )}
    </div>
  );
}
