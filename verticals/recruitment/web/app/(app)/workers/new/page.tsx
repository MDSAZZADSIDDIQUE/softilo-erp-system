"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";

export default function NewWorkerPage() {
  const router = useRouter();
  const [engagement, setEngagement] = useState("paye");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    try {
      await api("/api/rec/workers", {
        body: {
          firstName: f.firstName, lastName: f.lastName, email: f.email, phone: f.phone || undefined, engagement,
          umbrellaName: f.umbrellaName || undefined, companyName: f.companyName || undefined, companyNumber: f.companyNumber || undefined,
          ir35Status: engagement === "ltd" ? f.ir35Status : undefined, kidIssuedOn: f.kidIssuedOn || undefined,
          conductRegsOptOut: engagement === "ltd" && f.optOut === "on",
        },
      });
      router.push("/workers");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <PageHeader title="New worker">
        <button type="button" className="btn ghost" onClick={() => router.back()}>Cancel</button>
        <button className="btn primary" disabled={busy}>Save</button>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card title="Details" pad>
        <div className="form-grid">
          <Field label="First name"><input name="firstName" required autoFocus /></Field>
          <Field label="Last name"><input name="lastName" required /></Field>
          <Field label="Email"><input name="email" type="email" /></Field>
          <Field label="Phone"><input name="phone" type="tel" /></Field>
        </div>
      </Card>
      <Card title="Engagement" pad>
        <div className="form-grid">
          <Field label="Engaged as" hint={engagement === "umbrella" ? "Since April 2026 the agency is jointly liable for PAYE the umbrella company fails to pay: check the umbrella first." : undefined}>
            <select value={engagement} onChange={(e) => setEngagement(e.target.value)}>
              <option value="paye">PAYE: on the agency&apos;s payroll</option>
              <option value="umbrella">Umbrella company employee</option>
              <option value="ltd">Limited company contractor</option>
            </select>
          </Field>
          {engagement === "umbrella" && <Field label="Umbrella company"><input name="umbrellaName" required /></Field>}
          {engagement === "ltd" && <>
            <Field label="Company name"><input name="companyName" required /></Field>
            <Field label="Company number" hint="Companies House"><input name="companyNumber" maxLength={8} /></Field>
            <Field label="IR35 status" hint="From the client's Status Determination Statement, or the contractor if the client is small">
              <select name="ir35Status" defaultValue="outside"><option value="outside">Outside IR35</option><option value="inside">Inside IR35</option></select>
            </Field>
            <label className="checkbox"><input type="checkbox" name="optOut" /> Opted out of the Conduct Regulations (before introduction)</label>
          </>}
          {engagement !== "ltd" && (
            <Field label="Key Information Document issued" hint="Required before agreeing terms with the worker">
              <input name="kidIssuedOn" type="date" />
            </Field>
          )}
        </div>
      </Card>
    </form>
  );
}
