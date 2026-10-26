"use client";

import { useState } from "react";
import { CisPill } from "@/components/cons";
import { Card, DataTable, Empty, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { dateTime } from "@/lib/format";

interface Sub { contact_id: string; name: string; vat_number: string | null; business_type: string; utr: string; cis_status: string; verification_number: string | null; verified_at: string | null }

const TYPES: Record<string, string> = { sole_trader: "Sole trader", partnership: "Partnership", company: "Limited company", trust: "Trust" };

export default function SubcontractorsPage() {
  const { data, error, reload } = useApi<Sub[]>("/api/construction/subcontractors");
  const [message, setMessage] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [type, setType] = useState("sole_trader");

  async function verify(s: Sub) {
    setMessage(undefined);
    setFormError(undefined);
    try {
      const r = await api<{ status: string; verificationNumber: string; gateway: string }>(`/api/construction/subcontractors/${s.contact_id}/verify`, { method: "POST" });
      setMessage(`${s.name}: ${r.status === "gross" ? "pay gross, no deduction" : r.status === "net" ? "deduct 20%" : "not matched, deduct 30%"} (verification ${r.verificationNumber}${r.gateway === "stub" ? ", HMRC test stub" : ""}).`);
      reload();
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    setFormError(undefined);
    try {
      await api("/api/construction/subcontractors", { body: {
        name: f.name, businessType: f.businessType, utr: f.utr, vatNumber: f.vatNumber || undefined,
        nino: f.nino || undefined, companyNumber: f.companyNumber || undefined,
      } });
      form.reset();
      setType("sole_trader");
      reload();
    } catch (err) {
      setFormError((err as Error).message);
    }
  }

  return (
    <div className="stack">
      <PageHeader title="Subcontractors" subtitle="Verify each subcontractor with HMRC to find the CIS deduction rate." />
      <ErrorBanner message={error ?? formError} />
      {message && <div className="banner ok" role="status">{message}</div>}
      <Card>
        <DataTable rows={data} empty={<Empty title="No subcontractors yet">Add one below.</Empty>}
          columns={[
            { key: "n", label: "Name", render: (s) => s.name },
            { key: "t", label: "Type", render: (s) => TYPES[s.business_type] },
            { key: "u", label: "UTR", render: (s) => <span className="mono">{s.utr}</span> },
            { key: "v", label: "VAT", render: (s) => s.vat_number ? "Registered" : <span className="muted">Not registered</span> },
            { key: "s", label: "CIS status", render: (s) => <CisPill status={s.cis_status} /> },
            { key: "vn", label: "Verification", render: (s) => s.verification_number ? <span className="deadline"><span className="mono">{s.verification_number}</span><small>{dateTime(s.verified_at)}</small></span> : <span className="faint">–</span> },
            { key: "a", label: "", render: (s) => <button className={`btn small${s.cis_status === "unverified" ? " primary" : ""}`} onClick={() => verify(s)}>{s.cis_status === "unverified" ? "Verify" : "Re-verify"}</button> },
          ]} />
      </Card>
      <Card title="Add a subcontractor" pad>
        <form className="stack" style={{ gap: 16 }} onSubmit={add}>
          <div className="form-grid">
            <Field label="Name" hint="Exactly as registered with HMRC"><input name="name" required /></Field>
            <Field label="Business type">
              <select name="businessType" value={type} onChange={(e) => setType(e.target.value)}>
                {Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="UTR" hint="10 digits"><input name="utr" required inputMode="numeric" pattern="\d{10}" /></Field>
            {type === "sole_trader" && <Field label="National Insurance number"><input name="nino" /></Field>}
            {type === "company" && <Field label="Company number"><input name="companyNumber" /></Field>}
            <Field label="VAT number" hint="Leave blank if not VAT registered"><input name="vatNumber" /></Field>
          </div>
          <div><button className="btn primary">Add subcontractor</button></div>
        </form>
      </Card>
    </div>
  );
}
