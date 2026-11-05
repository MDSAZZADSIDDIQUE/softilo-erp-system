"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { money } from "@/lib/format";

interface Contact {
  id: string; kind: string; name: string; email: string | null; vat_number: string | null; company_number: string | null;
  currency: string; payment_terms_days: number; receivable: string; payable: string; credit_limit: string | null;
}

export default function ContactsPage() {
  const kind = useSearchParams().get("kind") === "supplier" ? "supplier" : "customer";
  const [search, setSearch] = useState("");
  const { data, error } = useApi<Contact[]>(`/api/contacts?kind=${kind}${search ? `&search=${encodeURIComponent(search)}` : ""}`);
  const label = kind === "customer" ? "Customers" : "Suppliers";
  const [check, setCheck] = useState<{ name: string; ok: boolean; lines: string[] }>();

  /** Check the contact against Companies House and HMRC's VAT register; the result is kept in the audit trail. */
  async function verify(c: Contact) {
    try {
      const r = await api<{ ok: boolean; warnings: string[]; company: { name: string; status: string } | null; vat: { valid: boolean; name?: string; consultationNumber?: string } | null }>(`/api/contacts/${c.id}/verify`, { body: {} });
      const lines = [
        r.company ? `Companies House: ${r.company.name}, ${r.company.status}.` : c.company_number ? "" : "No company number held.",
        r.vat ? (r.vat.valid ? `VAT number valid${r.vat.name ? `, registered to ${r.vat.name}` : ""}${r.vat.consultationNumber ? ` (HMRC consultation ${r.vat.consultationNumber})` : ""}.` : "") : c.vat_number ? "" : "No VAT number held.",
        ...r.warnings,
      ].filter(Boolean);
      setCheck({ name: c.name, ok: r.ok, lines });
    } catch (e) {
      setCheck({ name: c.name, ok: false, lines: [(e as Error).message] });
    }
  }

  return (
    <div className="stack">
      <PageHeader title={label} subtitle={kind === "customer" ? "Who you sell to, and what they owe." : "Who you buy from, and what you owe them."}>
        <Link className="btn primary" href={`/contacts/new?kind=${kind}`}>New {kind}</Link>
      </PageHeader>
      <ErrorBanner message={error} />
      {check && <div className={`banner ${check.ok ? "ok" : "error"}`} role="status"><strong style={{ fontWeight: 500 }}>{check.name}</strong>: {check.lines.join(" ")}</div>}
      <Card title={<input type="search" placeholder={`Search ${label.toLowerCase()}…`} value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 320 }} />}>
        <DataTable rows={data}
          empty={<Empty title={`No ${label.toLowerCase()} yet`}><Link href={`/contacts/new?kind=${kind}`}>Add your first {kind}</Link></Empty>}
          columns={[
            { key: "name", label: "Name", render: (c) => <strong style={{ fontWeight: 500 }}>{c.name}</strong> },
            { key: "email", label: "Email", render: (c) => c.email ?? <span className="faint">–</span> },
            { key: "vat", label: "VAT number", render: (c) => c.vat_number ? `GB${c.vat_number}` : <span className="faint">–</span> },
            { key: "cur", label: "Currency", render: (c) => c.currency },
            { key: "terms", label: "Terms", render: (c) => `${c.payment_terms_days} days` },
            kind === "customer"
              ? { key: "bal", label: "Owes you", num: true, render: (c) => money(c.receivable, c.currency) }
              : { key: "bal", label: "You owe", num: true, render: (c) => money(c.payable, c.currency) },
            ...(kind === "customer" ? [{ key: "lim", label: "Credit limit", num: true, render: (c: Contact) => c.credit_limit ? <span className={Number(c.receivable) > Number(c.credit_limit) ? "warn" : undefined}>{money(c.credit_limit)}</span> : <span className="faint">–</span> }] : []),
            { key: "chk", label: "", num: true, render: (c) => (c.company_number || c.vat_number) ? <button className="btn small ghost" onClick={() => void verify(c)}>Check</button> : null },
          ]} />
      </Card>
    </div>
  );
}
