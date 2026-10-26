"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, ErrorBanner, Field, Loading, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { amount } from "@/lib/format";

interface Account { code: string; name: string; type: string; role: string | null; is_control: boolean; is_bank: boolean; archived: boolean; balance: string }
const TYPES = [["asset", "Assets"], ["liability", "Liabilities"], ["equity", "Equity"], ["income", "Income"], ["expense", "Expenses"]] as const;

export default function AccountsPage() {
  const { data, error, reload } = useApi<Account[]>("/api/accounts");
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string>();

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api(f.type === "bank" ? "/api/bank-accounts" : "/api/accounts", { body: f.type === "bank" ? { code: f.code, name: f.name } : f });
      setAdding(false);
      setFormError(undefined);
      await reload();
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  return (
    <div className="stack">
      <PageHeader title="Chart of accounts" subtitle="UK layout. System accounts are marked and can't be archived.">
        <button className="btn primary" onClick={() => setAdding((a) => !a)}>New account</button>
      </PageHeader>
      <ErrorBanner message={error} />
      {adding && (
        <Card title="New account" pad>
          <ErrorBanner message={formError} />
          <form onSubmit={add} className="form-grid" style={{ alignItems: "end" }}>
            <Field label="Code" hint="4 digits"><input name="code" pattern="\d{4}" required /></Field>
            <Field label="Name"><input name="name" required /></Field>
            <Field label="Type">
              <select name="type">
                {TYPES.map(([t, l]) => <option key={t} value={t}>{l.replace(/s$/, "")}</option>)}
                <option value="bank">Bank account</option>
              </select>
            </Field>
            <button className="btn primary">Add account</button>
          </form>
        </Card>
      )}
      {!data ? <Card><Loading /></Card> : TYPES.map(([type, label]) => {
        const rows = data.filter((a) => a.type === type && !a.archived);
        return (
          <Card key={type} title={label}>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th style={{ width: 90 }}>Code</th><th>Name</th><th /><th className="num">Balance</th></tr></thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.code}>
                      <td><Link href={`/accounts/${a.code}`}>{a.code}</Link></td>
                      <td>{a.name}</td>
                      <td>
                        {a.is_control && <span className="pill quiet">Control</span>} {a.is_bank && <span className="pill quiet">Bank</span>} {a.role && !a.is_control && !a.is_bank && <span className="pill quiet">System</span>}
                      </td>
                      <td className="num">{Number(a.balance) ? amount(a.balance) : <span className="faint">–</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
