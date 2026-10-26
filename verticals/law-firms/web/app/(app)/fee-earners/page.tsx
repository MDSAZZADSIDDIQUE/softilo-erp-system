"use client";

import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, Field, Money, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import type { FeeEarner } from "@law/lib/types";

export default function FeeEarnersPage() {
  const { data, error, reload } = useApi<FeeEarner[]>("/api/law/fee-earners");
  const [formError, setFormError] = useState<string>();

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      await api("/api/law/fee-earners", { body: Object.fromEntries(new FormData(form)) });
      form.reset();
      setFormError(undefined);
      await reload();
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  return (
    <div className="stack">
      <PageHeader title="Fee earners" subtitle="Time is valued in six-minute units at each fee earner's hourly rate." />
      <ErrorBanner message={error} />
      <div className="grid-main">
        <Card>
          <DataTable rows={data}
            empty={<Empty title="No fee earners yet">Add the solicitors, legal executives and paralegals who record time.</Empty>}
            columns={[
              { key: "name", label: "Name", render: (r) => r.name },
              { key: "initials", label: "Initials", render: (r) => <span className="mono">{r.initials}</span> },
              { key: "rate", label: "Hourly rate", num: true, render: (r) => <Money value={r.hourly_rate} /> },
              { key: "unit", label: "Per unit", num: true, render: (r) => <Money value={(Number(r.hourly_rate) / 10).toFixed(2)} /> },
            ]} />
        </Card>
        <Card title="Add a fee earner" pad>
          <form className="stack" onSubmit={submit}>
            <ErrorBanner message={formError} />
            <Field label="Name"><input name="name" required /></Field>
            <Field label="Initials"><input name="initials" required maxLength={6} /></Field>
            <Field label="Hourly rate (£)" hint="Excluding VAT"><input name="hourlyRate" inputMode="decimal" required pattern="\d+(\.\d{1,2})?" /></Field>
            <button className="btn primary">Add fee earner</button>
          </form>
        </Card>
      </div>
    </div>
  );
}
