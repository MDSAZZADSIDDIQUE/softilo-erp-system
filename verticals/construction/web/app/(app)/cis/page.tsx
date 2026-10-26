"use client";

import Link from "next/link";
import { useState } from "react";
import { shiftTaxMonth, taxMonthEndFor } from "@/components/cons";
import { Card, DataTable, Empty, ErrorBanner, Field, Loading, PageHeader, Stat } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date, dateTime, money, today } from "@/lib/format";

interface Statement {
  subcontractor: { id: string; name: string; utr: string; status: string };
  verificationNumber: string | null;
  lines: { billNumber: string; supplierRef: string; paymentDate: string; paid: string; gross: string; materials: string; deduction: string }[];
  grossPaid: string; costOfMaterials: string; amountLiable: string; amountDeducted: string; netPaid: string;
}
interface Preview {
  contractor: { name: string; contractor_utr: string | null; employer_ref: string | null; accounts_office_ref: string | null };
  submitted: { submitted_at: string; hmrc_receipt: { correlationId: string } } | null;
  month: { start: string; end: string; taxYear: string; number: number; returnDue: string; paymentDue: string; statementsDue: string };
  statements: Statement[];
  totals: { grossPaid: string; costOfMaterials: string; amountDeducted: string; subcontractors: number };
  nil: boolean;
}

export default function CisPage() {
  const [month, setMonth] = useState(() => shiftTaxMonth(taxMonthEndFor(today()), -1));
  const { data, error, reload } = useApi<Preview>(`/api/construction/cis/preview?monthEnding=${month}`);
  const [statement, setStatement] = useState<Statement>();
  const [submitError, setSubmitError] = useState<string>();
  const [declared, setDeclared] = useState({ employmentStatus: false, verification: false });
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setSubmitError(undefined);
    try {
      await api("/api/construction/cis/returns", { body: { monthEnding: month, declarations: declared } });
      reload();
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PageHeader title="CIS returns" subtitle="Monthly CIS300 return and payment and deduction statements, built from the payments you made.">
        <button className="btn" onClick={() => setMonth((m) => shiftTaxMonth(m, -1))} aria-label="Previous tax month">← Previous</button>
        <button className="btn" onClick={() => setMonth((m) => shiftTaxMonth(m, 1))} aria-label="Next tax month">Next →</button>
      </PageHeader>
      <ErrorBanner message={error ?? submitError} />
      {!data ? <Loading rows={5} /> : (
        <>
          <div className="grid-4">
            <Stat label="Tax month" value={`Month ${data.month.number}`} sub={`${date(data.month.start)} to ${date(data.month.end)} · ${data.month.taxYear}`} />
            <Stat label="Paid to subcontractors" value={money(data.totals.grossPaid)} sub={`Materials ${money(data.totals.costOfMaterials)}`} />
            <Stat label="Deducted" value={money(data.totals.amountDeducted)} sub={`Pay HMRC by ${date(data.month.paymentDue)}`} alert={!data.submitted && Number(data.totals.amountDeducted) > 0} />
            <Stat label="Return" value={data.submitted ? "Submitted" : data.nil ? "Nil return" : "Not submitted"}
              sub={data.submitted ? dateTime(data.submitted.submitted_at) : `Due ${date(data.month.returnDue)}`} alert={!data.submitted} />
          </div>
          {(!data.contractor.contractor_utr || !data.contractor.employer_ref) && <ContractorSettings onSaved={reload} />}
          <Card title={`CIS300 for month ending ${date(data.month.end)}`}>
            <DataTable rows={data.statements}
              empty={<Empty title="No subcontractors paid this month">Since 6 April 2026 you must file a nil return, or ask HMRC to mark you inactive in advance.</Empty>}
              columns={[
                { key: "n", label: "Subcontractor", render: (s) => s.subcontractor.name },
                { key: "u", label: "UTR", render: (s) => <span className="mono">{s.subcontractor.utr}</span> },
                { key: "v", label: "Verification no.", render: (s) => s.verificationNumber ? <span className="mono">{s.verificationNumber}</span> : <span className="faint">–</span> },
                { key: "g", label: "Total payments", num: true, render: (s) => money(s.grossPaid) },
                { key: "m", label: "Cost of materials", num: true, render: (s) => money(s.costOfMaterials) },
                { key: "d", label: "Amount deducted", num: true, render: (s) => money(s.amountDeducted) },
                { key: "a", label: "", render: (s) => <button className="btn small" onClick={() => setStatement(s)}>Statement</button> },
              ]}
              footer={data.statements.length ? <tr><td colSpan={3}>Total</td><td className="num">{money(data.totals.grossPaid)}</td><td className="num">{money(data.totals.costOfMaterials)}</td><td className="num">{money(data.totals.amountDeducted)}</td><td /></tr> : undefined} />
          </Card>
          {data.submitted ? (
            <div className="banner ok">Submitted {dateTime(data.submitted.submitted_at)}. HMRC reference {data.submitted.hmrc_receipt.correlationId}.</div>
          ) : (
            <Card title="Submit to HMRC" pad>
              <div className="stack" style={{ gap: 12 }}>
                <label className="checkbox"><input type="checkbox" checked={declared.employmentStatus} onChange={(e) => setDeclared((d) => ({ ...d, employmentStatus: e.target.checked }))} /> None of the subcontractors listed is an employee</label>
                <label className="checkbox"><input type="checkbox" checked={declared.verification} onChange={(e) => setDeclared((d) => ({ ...d, verification: e.target.checked }))} /> Every subcontractor that needed verifying has been verified</label>
                <p className="note" style={{ margin: 0 }}>Submission goes through Softilo&apos;s HMRC adapter. Until HMRC credentials are in place, it uses a test stub and nothing reaches HMRC.</p>
                <div><button className="btn accent" disabled={busy || !declared.employmentStatus || !declared.verification} onClick={submit}>{busy ? "Submitting…" : data.nil ? "Submit nil return" : "Submit return"}</button></div>
              </div>
            </Card>
          )}
          {statement && <StatementDoc s={statement} p={data} onClose={() => setStatement(undefined)} />}
        </>
      )}
      <p className="note">Statements must reach subcontractors within 14 days of the end of the tax month. <Link href="/subcontractors">Manage subcontractors</Link></p>
    </div>
  );
}

function ContractorSettings({ onSaved }: { onSaved: () => void }) {
  const [error, setError] = useState<string>();
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(undefined);
    try {
      await api("/api/construction/settings", { method: "PUT", body: Object.fromEntries(new FormData(e.currentTarget)) });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Card title="Your CIS references" pad>
      <form className="stack" style={{ gap: 14 }} onSubmit={save}>
        <p className="note" style={{ margin: 0 }}>HMRC needs these on every return and verification request.</p>
        <ErrorBanner message={error} />
        <div className="form-grid">
          <Field label="Contractor UTR"><input name="contractorUtr" required inputMode="numeric" pattern="\d{10}" /></Field>
          <Field label="Employer reference" hint="e.g. 123/AB45678"><input name="employerRef" required /></Field>
          <Field label="Accounts office reference"><input name="accountsOfficeRef" /></Field>
        </div>
        <div><button className="btn primary">Save references</button></div>
      </form>
    </Card>
  );
}

function StatementDoc({ s, p, onClose }: { s: Statement; p: Preview; onClose: () => void }) {
  return (
    <div className="stack">
      <div className="actions no-print">
        <button className="btn" onClick={() => window.print()}>Print statement</button>
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>
      <article className="document">
        <header>
          <div>
            <div className="doc-title">Payment and deduction statement</div>
            <p className="muted" style={{ margin: "6px 0 0" }}>Construction Industry Scheme · tax month ending {date(p.month.end)}</p>
          </div>
          <div style={{ textAlign: "right" }}>
            <img src="/brand/logo.svg" alt="Softilo" />
            <div className="accent-rule" />
          </div>
        </header>
        <div className="grid-2" style={{ marginBottom: 24 }}>
          <dl className="meta">
            <dt>Contractor</dt><dd>{p.contractor.name}</dd>
            <dt>Employer reference</dt><dd>{p.contractor.employer_ref ?? "–"}</dd>
          </dl>
          <dl className="meta">
            <dt>Subcontractor</dt><dd>{s.subcontractor.name}</dd>
            <dt>UTR</dt><dd>{s.subcontractor.utr}</dd>
            {s.verificationNumber && <><dt>Verification number</dt><dd>{s.verificationNumber}</dd></>}
          </dl>
        </div>
        <table className="data">
          <thead><tr><th>Paid</th><th>Bill</th><th className="num">Gross (excl. VAT)</th><th className="num">Materials</th><th className="num">Deducted</th></tr></thead>
          <tbody>
            {s.lines.map((l, i) => (
              <tr key={i}><td>{date(l.paymentDate)}</td><td>{l.supplierRef}</td><td className="num">{money(l.gross)}</td><td className="num">{money(l.materials)}</td><td className="num">{money(l.deduction)}</td></tr>
            ))}
          </tbody>
        </table>
        <div className="calc" style={{ maxWidth: 360, marginLeft: "auto", marginTop: 20 }}>
          <span>Gross amount paid (excl. VAT)</span><span>{money(s.grossPaid)}</span>
          <span>Less cost of materials</span><span>{money(s.costOfMaterials)}</span>
          <span>Amount liable to deduction</span><span>{money(s.amountLiable)}</span>
          <span className="rule" />
          <span className="strong">Amount deducted</span><span className="strong">{money(s.amountDeducted)}</span>
          <span>Amount paid to you</span><span>{money(s.netPaid)}</span>
        </div>
      </article>
    </div>
  );
}
