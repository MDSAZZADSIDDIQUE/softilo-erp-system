"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { Card, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";

export default function NewContactPage() {
  const router = useRouter();
  const initialKind = useSearchParams().get("kind") === "supplier" ? "supplier" : "customer";
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ companyNumber: string; name: string; status: string; address: string }[]>();
  const [found, setFound] = useState<string>();

  async function search() {
    try { setResults(await api(`/api/lookup/companies?q=${encodeURIComponent(query)}`)); setError(undefined); }
    catch (e) { setError((e as Error).message); }
  }

  /** Fill the form from the Companies House register. */
  async function pick(number: string) {
    try {
      const p = await api<{ name: string; companyNumber: string; status: string; address: { line1?: string; line2?: string; city?: string; postcode?: string } }>(`/api/lookup/companies/${number}`);
      const el = form.current!.elements as unknown as Record<string, HTMLInputElement>;
      const title = p.name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bLtd\b/i, "Ltd").replace(/\bPlc\b/, "plc").replace(/\bLlp\b/, "LLP");
      el.name!.value = title;
      el.companyNumber!.value = p.companyNumber;
      el.line1!.value = [p.address.line1, p.address.line2].filter(Boolean).join(", ");
      el.city!.value = p.address.city ?? "";
      el.postcode!.value = p.address.postcode ?? "";
      el.country!.value = "GB";
      setFound(p.status === "active" ? `Filled in from Companies House: ${p.name}, ${p.companyNumber}.` : `Warning: Companies House lists ${p.name} as ${p.status}.`);
      setResults(undefined);
    } catch (e) { setError((e as Error).message); }
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    try {
      await api("/api/contacts", {
        body: {
          kind: f.kind, name: f.name, email: f.email, phone: f.phone || undefined,
          companyNumber: f.companyNumber || undefined, vatNumber: f.vatNumber || undefined,
          currency: f.currency, paymentTermsDays: Number(f.paymentTermsDays), creditLimit: f.creditLimit || undefined,
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
    <form className="stack" onSubmit={submit} ref={form}>
      <PageHeader title={`New ${initialKind}`}>
        <button type="button" className="btn ghost" onClick={() => router.back()}>Cancel</button>
        <button className="btn primary" disabled={busy}>Save</button>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card title="Find on Companies House" pad>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Company name or number" aria-label="Company name or number" style={{ flex: "1 1 240px" }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void search(); } }} />
          <button type="button" className="btn" disabled={query.trim().length < 2} onClick={() => void search()}>Search</button>
        </div>
        {found && <p className={found.startsWith("Warning") ? "warn" : "muted"} style={{ margin: "10px 0 0" }}>{found}</p>}
        {results && (results.length ? (
          <div className="rows" style={{ marginTop: 10 }}>
            {results.map((r) => (
              <a key={r.companyNumber} href="#" onClick={(e) => { e.preventDefault(); void pick(r.companyNumber); }}>
                <span>{r.name}<small>{r.companyNumber} · {r.address}</small></span>
                <span className="end"><span className={`pill ${r.status === "active" ? "quiet" : "signal"}`}>{r.status}</span></span>
              </a>
            ))}
          </div>
        ) : <p className="muted" style={{ margin: "10px 0 0" }}>No companies found.</p>)}
      </Card>
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
          <Field label="Credit limit (£)" hint="Customers only. Blank for none"><input name="creditLimit" inputMode="decimal" /></Field>
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
