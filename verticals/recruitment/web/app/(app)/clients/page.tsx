"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { money, VAT_CODES } from "@/lib/format";

interface Client { id: string; name: string; email: string | null; client_size: string; vat_code: string; payment_terms_days: number; active_placements: number; outstanding: string }
interface Consultant { id: string; name: string; email: string | null }

export default function ClientsPage() {
  const clients = useApi<Client[]>("/api/rec/clients");
  const consultants = useApi<Consultant[]>("/api/rec/consultants");
  const [error, setError] = useState<string>();

  async function addClient(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    try {
      await api("/api/rec/clients", { body: {
        name: f.name, email: f.email, companyNumber: f.companyNumber || undefined, vatNumber: f.vatNumber || undefined,
        clientSize: f.clientSize, vatCode: f.vatCode, paymentTermsDays: Number(f.paymentTermsDays),
      } });
      form.reset();
      setError(undefined);
      await clients.reload();
    } catch (err) { setError((err as Error).message); }
  }

  async function addConsultant(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    try {
      await api("/api/rec/consultants", { body: { name: f.name, email: f.email } });
      form.reset();
      await consultants.reload();
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <div className="stack">
      <PageHeader title="Clients" subtitle="Hirers you supply workers to. Invoices and payments use the core sales ledger." />
      <ErrorBanner message={error ?? clients.error} />
      <Card>
        <DataTable rows={clients.data}
          empty={<Empty title="No clients yet">Add your first client below.</Empty>}
          columns={[
            { key: "n", label: "Client", render: (c) => <>{c.name}{c.email && <div className="faint">{c.email}</div>}</> },
            { key: "s", label: "Off-payroll size", render: (c) => (c.client_size === "small" ? "Small" : "Medium or large") },
            { key: "t", label: "Terms", render: (c) => `${c.payment_terms_days} days` },
            { key: "v", label: "VAT", render: (c) => c.vat_code },
            { key: "p", label: "Active placements", num: true, render: (c) => c.active_placements },
            { key: "o", label: "Owed", num: true, render: (c) => money(c.outstanding) },
            { key: "a", label: "", render: (c) => <Link href={`/placements/new?client=${c.id}`}>Place a worker</Link> },
          ]} />
      </Card>
      <Card title="Add a client" pad>
        <form className="form-grid" onSubmit={addClient}>
          <Field label="Name"><input name="name" required /></Field>
          <Field label="Accounts email"><input name="email" type="email" /></Field>
          <Field label="Company number"><input name="companyNumber" maxLength={8} /></Field>
          <Field label="VAT number"><input name="vatNumber" placeholder="GB123456789" /></Field>
          <Field label="Size for off-payroll rules" hint="Medium and large clients must issue a Status Determination Statement to contractors">
            <select name="clientSize" defaultValue="medium_large"><option value="medium_large">Medium or large</option><option value="small">Small</option></select>
          </Field>
          <Field label="VAT on invoices" hint="Supplies of staff are normally standard-rated">
            <select name="vatCode" defaultValue="S20">{VAT_CODES.map((v) => <option key={v.code} value={v.code}>{v.label}</option>)}</select>
          </Field>
          <Field label="Payment terms (days)"><input name="paymentTermsDays" type="number" min={0} max={180} defaultValue={30} /></Field>
          <div style={{ alignSelf: "end" }}><button className="btn primary">Add client</button></div>
        </form>
      </Card>
      <Card title="Consultants" pad>
        <p className="muted" style={{ marginTop: 0 }}>{consultants.data?.length ? consultants.data.map((c) => c.name).join(" · ") : "No consultants yet."}</p>
        <form className="form-grid" onSubmit={addConsultant}>
          <Field label="Name"><input name="name" required /></Field>
          <Field label="Email"><input name="email" type="email" /></Field>
          <div style={{ alignSelf: "end" }}><button className="btn">Add consultant</button></div>
        </form>
      </Card>
    </div>
  );
}
