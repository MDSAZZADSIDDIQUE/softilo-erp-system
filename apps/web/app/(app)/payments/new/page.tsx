"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useAccounts, useContacts } from "@/components/pickers";
import { Card, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date, money, sumPence, today } from "@/lib/format";

interface OpenDoc { id: string; number: string; kind: string; date: string; due_date: string; currency: string; outstanding: string; customer_id?: string; supplier_id?: string; supplier_ref?: string }

export default function NewPaymentPage() {
  const router = useRouter();
  const params = useSearchParams();
  const direction = params.get("direction") === "payment" ? "payment" : "receipt";
  const contacts = useContacts(direction === "receipt" ? "customer" : "supplier");
  const banks = useAccounts((a) => a.is_bank);
  const [contactId, setContactId] = useState(params.get("contactId") ?? "");
  const contact = contacts.find((c) => c.id === contactId);
  const currency = contact?.currency ?? "GBP";
  const { data: docs } = useApi<OpenDoc[]>(direction === "receipt" ? "/api/sales-invoices" : "/api/supplier-bills");
  const open = (docs ?? []).filter((d) => (d.customer_id ?? d.supplier_id) === contactId && d.kind !== "credit" && Number(d.outstanding) > 0);
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // Pre-tick the document we came from.
  useEffect(() => {
    const docId = params.get("documentId");
    const doc = open.find((d) => d.id === docId);
    if (doc && !Object.keys(alloc).length) setAlloc({ [doc.id]: Number(doc.outstanding).toFixed(2) });
  }, [open.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const allocated = sumPence(Object.values(alloc));
  const [amount, setAmount] = useState("");
  const shownAmount = amount || (allocated ? allocated.toFixed(2) : "");

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    try {
      await api("/api/payments", {
        body: {
          direction, contactId, date: f.date, bankAccountCode: f.bankAccountCode, amount: shownAmount, reference: f.reference || undefined,
          rate: currency === "GBP" ? undefined : f.rate,
          allocations: Object.entries(alloc).filter(([, a]) => Number(a) > 0).map(([documentId, a]) => ({ documentId, amount: a })),
        },
      });
      router.push("/payments");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <PageHeader title={direction === "receipt" ? "Receive payment" : "Pay a supplier"}>
        <button type="button" className="btn ghost" onClick={() => router.back()}>Cancel</button>
        <button className="btn primary" disabled={busy || !contactId || !Number(shownAmount)}>Post {direction}</button>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card title="Payment" pad>
        <div className="form-grid">
          <Field label={direction === "receipt" ? "Customer" : "Supplier"}>
            <select value={contactId} onChange={(e) => { setContactId(e.target.value); setAlloc({}); }} required>
              <option value="">Choose…</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>)}
            </select>
          </Field>
          <Field label="Date"><input type="date" name="date" defaultValue={today()} required /></Field>
          <Field label="Bank account">
            <select name="bankAccountCode">{banks.map((b) => <option key={b.code} value={b.code}>{b.code} · {b.name}</option>)}</select>
          </Field>
          <Field label={`Amount (${currency})`}><input className="num" inputMode="decimal" value={shownAmount} onChange={(e) => setAmount(e.target.value)} required /></Field>
          {currency !== "GBP" && <Field label={`Rate on the day (GBP per 1 ${currency})`} hint="The difference to the invoice rate is a realised FX gain or loss"><input name="rate" className="num" inputMode="decimal" required /></Field>}
          <Field label="Reference"><input name="reference" /></Field>
        </div>
      </Card>
      {contactId && (
        <Card title="Allocate to open documents" actions={<span className="muted">{money(allocated, currency)} allocated{Number(shownAmount) > allocated ? ` · ${money(Number(shownAmount) - allocated, currency)} on account` : ""}</span>}>
          {!open.length ? <p className="muted card-pad" style={{ margin: 0 }}>Nothing outstanding. The payment will be held on account.</p> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th /><th>Document</th><th>Date</th><th>Due</th><th className="num">Outstanding</th><th className="num">Allocate</th></tr></thead>
                <tbody>
                  {open.map((d) => (
                    <tr key={d.id}>
                      <td><input type="checkbox" aria-label={`Allocate to ${d.number}`} checked={d.id in alloc} onChange={(e) => {
                        const next = { ...alloc };
                        if (e.target.checked) next[d.id] = Number(d.outstanding).toFixed(2); else delete next[d.id];
                        setAlloc(next);
                      }} /></td>
                      <td>{d.number}{d.supplier_ref && <span className="faint"> · {d.supplier_ref}</span>}</td>
                      <td>{date(d.date)}</td><td>{date(d.due_date)}</td>
                      <td className="num">{money(d.outstanding, d.currency)}</td>
                      <td className="num" style={{ width: 140 }}>{d.id in alloc && <input className="num" aria-label="Amount" value={alloc[d.id]} onChange={(e) => setAlloc({ ...alloc, [d.id]: e.target.value })} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </form>
  );
}
