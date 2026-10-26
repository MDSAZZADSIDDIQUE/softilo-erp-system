"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Card, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";

export default function NewContactPage() {
  const router = useRouter();
  const initialKind = useSearchParams().get("kind") === "supplier" ? "supplier" : "customer";
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    try {
      await api("/api/contacts", {
        body: {
          kind: f.kind, name: f.name, email: f.email, phone: f.phone || undefined,
          companyNumber: f.companyNumber || undefined, vatNumber: f.vatNumber || undefined,
          currency: f.currency, paymentTermsDays: Number(f.paymentTermsDays),
          address: { line1: f.line1 || undefined, city: f.city || undefined, postcode: f.postcode || undefined, country: f.country || undefined },
        },
      });
      router.push(`/contacts?kind=${f.kind === "supplier" ? "supplier" : "customer"}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <PageHeader title={`New ${initialKind}`}>
        <button type="button" className="btn ghost" onClick={() => router.back()}>Cancel</button>
        <button className="btn primary" disabled={busy}>Save</button>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card title="Details" pad>
        <div className="form-grid">
          <Field label="Type">
            <select name="kind" defaultValue={initialKind}>
              <option value="customer">Customer</option>
              <option value="supplier">Supplier</option>
              <option value="both">Customer and supplier</option>
            </select>
          </Field>
          <Field label="Name"><input name="name" required autoFocus /></Field>
          <Field label="Email"><input name="email" type="email" /></Field>
          <Field label="Phone"><input name="phone" type="tel" /></Field>
          <Field label="Company number" hint="Companies House"><input name="companyNumber" maxLength={8} /></Field>
          <Field label="VAT number"><input name="vatNumber" placeholder="GB123456789" /></Field>
          <Field label="Currency" hint="Documents default to this currency">
            <select name="currency" defaultValue="GBP">
              {["GBP", "EUR", "USD", "CNY", "JPY", "CHF", "CAD", "AUD"].map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Payment terms (days)"><input name="paymentTermsDays" type="number" min={0} max={365} defaultValue={30} /></Field>
        </div>
      </Card>
      <Card title="Address" pad>
        <div className="form-grid">
          <Field label="Address"><input name="line1" /></Field>
          <Field label="Town or city"><input name="city" /></Field>
          <Field label="Postcode"><input name="postcode" maxLength={10} /></Field>
          <Field label="Country code"><input name="country" maxLength={2} placeholder="GB" /></Field>
        </div>
      </Card>
    </form>
  );
}
