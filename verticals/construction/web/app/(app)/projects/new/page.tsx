"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CATEGORY_LABELS } from "@/components/cons";
import { Card, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { money, sumPence } from "@/lib/format";

interface BudgetLine { category: string; description: string; amount: string }

export default function NewProject() {
  const router = useRouter();
  const customers = useApi<{ id: string; name: string }[]>("/api/contacts?kind=customer").data ?? [];
  const [budget, setBudget] = useState<BudgetLine[]>([
    { category: "labour", description: "Labour", amount: "" },
    { category: "materials", description: "Materials", amount: "" },
  ]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api<{ id: string }>("/api/construction/projects", { body: {
        code: f.code, name: f.name, customerId: f.customerId, siteAddress: f.siteAddress || undefined, contractSum: f.contractSum,
        retentionRate: (Number(f.retentionPercent || 0) / 100).toFixed(4), vatRate: f.vatRate,
        customerCisRegistered: f.customerCisRegistered === "on", endUserNotice: f.endUserNotice === "on",
        fivePercentDisregard: f.fivePercentDisregard === "on", startDate: f.startDate || undefined,
        dueDays: Number(f.dueDays), finalDays: Number(f.finalDays), paymentNoticeDays: Number(f.paymentNoticeDays), payLessDays: Number(f.payLessDays),
        budget: budget.filter((b) => b.amount !== ""),
      } });
      router.push(`/projects/${r.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const set = (i: number, patch: Partial<BudgetLine>) => setBudget((b) => b.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <form className="stack" onSubmit={submit}>
      <PageHeader title="New project" subtitle="The contract, how it is paid, and what you expect it to cost.">
        <Link className="btn" href="/projects">Cancel</Link>
        <button className="btn primary" disabled={busy}>{busy ? "Saving…" : "Create project"}</button>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card title="Contract" pad>
        <div className="form-grid">
          <Field label="Code"><input name="code" required maxLength={20} placeholder="NG01" /></Field>
          <Field label="Project name"><input name="name" required /></Field>
          <Field label="Customer" hint={customers.length ? undefined : "Add the customer as a contact first"}>
            <select name="customerId" required defaultValue="">
              <option value="" disabled>Choose…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Contract sum (£)"><input name="contractSum" className="num" inputMode="decimal" required /></Field>
          <Field label="Retention (%)" hint="Half is released at practical completion"><input name="retentionPercent" className="num" defaultValue="5" inputMode="decimal" /></Field>
          <Field label="Start date"><input name="startDate" type="date" /></Field>
          <Field label="Site address"><input name="siteAddress" /></Field>
        </div>
      </Card>
      <Card title="VAT" pad>
        <div className="stack" style={{ gap: 14 }}>
          <div className="form-grid">
            <Field label="VAT rate of the work">
              <select name="vatRate" defaultValue="standard">
                <option value="standard">Standard rate (20%)</option>
                <option value="reduced">Reduced rate (5%)</option>
                <option value="zero">Zero rated (e.g. new dwellings)</option>
              </select>
            </Field>
          </div>
          <label className="checkbox"><input type="checkbox" name="customerCisRegistered" defaultChecked /> Customer is a CIS contractor and reports this work under CIS</label>
          <label className="checkbox"><input type="checkbox" name="endUserNotice" /> Written end-user or intermediary supplier notice held</label>
          <label className="checkbox"><input type="checkbox" name="fivePercentDisregard" /> 5% disregard agreed at the start of the contract</label>
          <p className="note" style={{ margin: 0 }}>The domestic reverse charge applies when you and the customer are both VAT registered, the customer reports the payment under CIS, the work is standard or reduced rated, and the customer has not told you in writing that they are an end user.</p>
        </div>
      </Card>
      <Card title="Payment terms" pad>
        <div className="form-grid">
          <Field label="Due date (days after valuation)"><input name="dueDays" type="number" min={0} defaultValue={7} /></Field>
          <Field label="Final date for payment (days after due)"><input name="finalDays" type="number" min={0} defaultValue={17} /></Field>
          <Field label="Payment notice (days after due)"><input name="paymentNoticeDays" type="number" min={0} defaultValue={5} /></Field>
          <Field label="Pay-less notice (days before final)"><input name="payLessDays" type="number" min={0} defaultValue={7} /></Field>
        </div>
        <p className="note">The defaults follow the Scheme for Construction Contracts, which applies when the contract does not set its own periods.</p>
      </Card>
      <Card title="Budget" actions={<button type="button" className="btn small" onClick={() => setBudget((b) => [...b, { category: "other", description: "", amount: "" }])}>Add line</button>}>
        <div className="table-wrap">
          <table className="lines">
            <thead><tr><th>Category</th><th>Description</th><th className="num">Amount (£)</th><th /></tr></thead>
            <tbody>
              {budget.map((b, i) => (
                <tr key={i}>
                  <td><select value={b.category} onChange={(e) => set(i, { category: e.target.value })} aria-label="Category">
                    {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select></td>
                  <td><input value={b.description} onChange={(e) => set(i, { description: e.target.value })} aria-label="Description" /></td>
                  <td><input className="num" value={b.amount} onChange={(e) => set(i, { amount: e.target.value })} inputMode="decimal" aria-label="Amount" /></td>
                  <td><button type="button" className="btn ghost small" onClick={() => setBudget((x) => x.filter((_, j) => j !== i))}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="totals"><span>Total budget</span><span className="grand">{money(sumPence(budget.map((b) => b.amount)))}</span></div>
      </Card>
    </form>
  );
}
