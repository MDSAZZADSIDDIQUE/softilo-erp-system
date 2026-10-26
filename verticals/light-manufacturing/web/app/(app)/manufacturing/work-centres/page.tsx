"use client";

import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { money } from "@/lib/format";

interface WorkCentre { id: string; code: string; name: string; labour_rate: string; overhead_rate: string }

export default function WorkCentresPage() {
  const { data, error, reload } = useApi<WorkCentre[]>("/api/mfg/work-centres");
  const [formError, setFormError] = useState<string>();
  const [editing, setEditing] = useState<string | null>(null);

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    try {
      await api("/api/mfg/work-centres", { body: f });
      form.reset();
      setFormError(undefined);
      await reload();
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  async function save(e: React.FormEvent<HTMLFormElement>, id: string) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      await api(`/api/mfg/work-centres/${id}`, { method: "PATCH", body: f });
      setEditing(null);
      await reload();
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  return (
    <div className="stack">
      <PageHeader title="Work centres" subtitle="Where work is done, and the standard rates used to absorb labour and overhead into work in progress." />
      <ErrorBanner message={error ?? formError} />
      <Card>
        <DataTable rows={data} empty={<Empty title="No work centres yet">Add one below, e.g. an assembly bench or a CNC cell.</Empty>}
          columns={[
            { key: "c", label: "Code", render: (w) => <strong>{w.code}</strong> },
            { key: "n", label: "Name", render: (w) => w.name },
            { key: "l", label: "Labour rate", num: true, render: (w) => editing === w.id
              ? <input form={`wc-${w.id}`} name="labourRate" className="num" inputMode="decimal" defaultValue={w.labour_rate} aria-label="Labour rate" style={{ width: 110 }} />
              : `${money(w.labour_rate)}/h` },
            { key: "o", label: "Overhead rate", num: true, render: (w) => editing === w.id
              ? <input form={`wc-${w.id}`} name="overheadRate" className="num" inputMode="decimal" defaultValue={w.overhead_rate} aria-label="Overhead rate" style={{ width: 110 }} />
              : `${money(w.overhead_rate)}/h` },
            { key: "a", label: "", num: true, render: (w) => editing === w.id
              ? <form id={`wc-${w.id}`} onSubmit={(e) => save(e, w.id)} className="actions" style={{ justifyContent: "flex-end" }}>
                  <button type="button" className="btn ghost small" onClick={() => setEditing(null)}>Cancel</button>
                  <button className="btn primary small">Save rates</button>
                </form>
              : <button className="btn small" onClick={() => setEditing(w.id)}>Change rates</button> },
          ]} />
      </Card>
      <Card title="Add a work centre" pad>
        <form onSubmit={add} className="stack" style={{ gap: 16 }}>
          <div className="form-grid">
            <Field label="Code"><input name="code" required maxLength={20} placeholder="ASSY" /></Field>
            <Field label="Name"><input name="name" required placeholder="Assembly bench" /></Field>
            <Field label="Labour rate (£ per hour)" hint="Direct wage cost including employer NI and pension">
              <input name="labourRate" className="num" inputMode="decimal" required placeholder="18.00" />
            </Field>
            <Field label="Overhead rate (£ per hour)" hint="Budgeted production overhead ÷ hours at normal capacity (FRS 102)">
              <input name="overheadRate" className="num" inputMode="decimal" required placeholder="12.00" />
            </Field>
          </div>
          <div><button className="btn primary">Add work centre</button></div>
        </form>
      </Card>
    </div>
  );
}
