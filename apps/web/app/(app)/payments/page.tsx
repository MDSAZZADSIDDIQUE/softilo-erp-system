"use client";

import Link from "next/link";
import { Card, DataTable, Empty, ErrorBanner, PageHeader, Status } from "@/components/ui";
import { useApi } from "@/lib/api";
import { date, money } from "@/lib/format";

interface Payment { id: string; number: string; direction: string; contact_name: string; date: string; bank_account_code: string; currency: string; amount: string; reference: string | null; unallocated: string; reconciled: boolean; entry_id: string }

export default function PaymentsPage() {
  const { data, error } = useApi<Payment[]>("/api/payments");
  return (
    <div className="stack">
      <PageHeader title="Payments & receipts" subtitle="Money in from customers and out to suppliers.">
        <Link className="btn" href="/payments/new?direction=payment">Pay a supplier</Link>
        <Link className="btn primary" href="/payments/new?direction=receipt">Receive payment</Link>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card>
        <DataTable rows={data} href={(p) => `/journals/${p.entry_id}`} empty={<Empty title="No payments yet" />} columns={[
          { key: "n", label: "Number", render: (p) => p.number },
          { key: "d", label: "Date", render: (p) => date(p.date) },
          { key: "c", label: "Contact", render: (p) => p.contact_name },
          { key: "r", label: "Reference", render: (p) => p.reference ?? <span className="faint">–</span> },
          { key: "b", label: "Bank", render: (p) => p.bank_account_code },
          { key: "s", label: "Bank status", render: (p) => <Status value={p.reconciled ? "reconciled" : "unreconciled"} /> },
          { key: "u", label: "Unallocated", num: true, render: (p) => Number(p.unallocated) ? money(p.unallocated, p.currency) : <span className="faint">–</span> },
          { key: "a", label: "Amount", num: true, render: (p) => money(p.direction === "payment" ? `-${p.amount}` : p.amount, p.currency) },
        ]} />
      </Card>
    </div>
  );
}
