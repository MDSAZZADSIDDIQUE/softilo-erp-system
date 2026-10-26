"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/api";
import { money } from "@/lib/format";

interface Contact {
  id: string; kind: string; name: string; email: string | null; vat_number: string | null; company_number: string | null;
  currency: string; payment_terms_days: number; receivable: string; payable: string;
}

export default function ContactsPage() {
  const kind = useSearchParams().get("kind") === "supplier" ? "supplier" : "customer";
  const [search, setSearch] = useState("");
  const { data, error } = useApi<Contact[]>(`/api/contacts?kind=${kind}${search ? `&search=${encodeURIComponent(search)}` : ""}`);
  const label = kind === "customer" ? "Customers" : "Suppliers";

  return (
    <div className="stack">
      <PageHeader title={label} subtitle={kind === "customer" ? "Who you sell to, and what they owe." : "Who you buy from, and what you owe them."}>
        <Link className="btn primary" href={`/contacts/new?kind=${kind}`}>New {kind}</Link>
      </PageHeader>
      <ErrorBanner message={error} />
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
          ]} />
      </Card>
    </div>
  );
}
