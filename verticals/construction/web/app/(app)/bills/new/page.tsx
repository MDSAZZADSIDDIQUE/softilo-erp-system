"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { CATEGORY_LABELS, CisPill } from "@/components/cons";
import { Card, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { money, roundHalfUp, sumPence, today, VAT_CODES, VAT_RATE } from "@/lib/format";

interface Line { category: string; description: string; net: string; vatCode: string }
interface Supplier { id: string; name: string; vat_number: string | null }
interface Sub { contact_id: string; cis_status: string }

const RATES: Record<string, number> = { gross: 0, net: 0.2, unmatched: 0.3 };

function BillForm() {
  const router = useRouter();
  const params = useSearchParams();
  const suppliers = useApi<Supplier[]>("/api/contacts?kind=supplier").data ?? [];
  const subs = useApi<Sub[]>("/api/construction/subcontractors").data ?? [];
  const projects = useApi<{ id: string; code: string; name: string }[]>("/api/construction/projects").data ?? [];
  const [supplierId, setSupplierId] = useState("");
  const [lines, setLines] = useState<Line[]>([{ category: "labour", description: "", net: "", vatCode: "" }]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const supplier = suppliers.find((s) => s.id === supplierId);
  const sub = subs.find((s) => s.contact_id === supplierId);
  const defaultVat = !supplier?.vat_number ? "OS" : sub ? "RC20" : "S20";
  const vatOf = (l: Line) => l.vatCode || defaultVat;

  // On-screen preview only; the server recalculates everything with decimal arithmetic.
  const gross = sumPence(lines.map((l) => l.net));
  const labour = sumPence(lines.filter((l) => l.category === "labour").map((l) => l.net));
  const vatCharged = sumPence(lines.map((l) => roundHalfUp(Number(l.net || 0) * (vatOf(l) === "RC20" ? 0 : VAT_RATE[vatOf(l)] ?? 0))));
  const rate = sub && sub.cis_status !== "unverified" ? RATES[sub.cis_status] ?? 0 : 0;
  const deduction = Math.floor(Math.round(labour * 100) * rate + 1e-9) / 100;
  const reverseCharge = lines.some((l) => vatOf(l) === "RC20");

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    setError(undefined);
    try {
      await api("/api/construction/bills", { body: {
        supplierId, projectId: f.projectId, supplierRef: f.supplierRef, date: f.date,
        lines: lines.map((l) => ({ category: l.category, description: l.description, net: l.net, vatCode: l.vatCode || undefined })),
      } });
      router.push("/bills");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <form className="stack" onSubmit={submit}>
      <PageHeader title="Enter job bill" subtitle="Split labour from materials: CIS is deducted from labour only.">
        <Link className="btn" href="/bills">Cancel</Link>
        <button className="btn primary" disabled={busy || !supplierId}>{busy ? "Posting…" : "Post bill"}</button>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card pad>
        <div className="form-grid">
          <Field label="Supplier or subcontractor" hint={sub ? <CisPill status={sub.cis_status} /> : supplier ? "Not a CIS subcontractor" : undefined}>
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
              <option value="" disabled>Choose…</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Project">
            <select name="projectId" required defaultValue={params.get("projectId") ?? ""}>
              <option value="" disabled>Choose…</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
            </select>
          </Field>
          <Field label="Their reference"><input name="supplierRef" required /></Field>
          <Field label="Bill date"><input name="date" type="date" defaultValue={today()} required /></Field>
        </div>
      </Card>
      <Card title="Lines" actions={<button type="button" className="btn small" onClick={() => setLines((l) => [...l, { category: "materials", description: "", net: "", vatCode: "" }])}>Add line</button>}>
        <div className="table-wrap">
          <table className="lines">
            <thead><tr><th>Type</th><th>Description</th><th>VAT</th><th className="num">Net (£)</th><th /></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td><select value={l.category} onChange={(e) => set(i, { category: e.target.value })} aria-label="Type">
                    {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select></td>
                  <td><input value={l.description} onChange={(e) => set(i, { description: e.target.value })} required aria-label="Description" /></td>
                  <td><select value={l.vatCode} onChange={(e) => set(i, { vatCode: e.target.value })} aria-label="VAT">
                    <option value="">Default ({VAT_CODES.find((v) => v.code === defaultVat)?.label})</option>
                    {VAT_CODES.map((v) => <option key={v.code} value={v.code}>{v.label}</option>)}
                  </select></td>
                  <td><input className="num" value={l.net} onChange={(e) => set(i, { net: e.target.value })} inputMode="decimal" required aria-label="Net" /></td>
                  <td>{lines.length > 1 && <button type="button" className="btn ghost small" onClick={() => setLines((x) => x.filter((_, j) => j !== i))}>Remove</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-pad" style={{ borderTop: "1px solid var(--border)" }}>
          <div className="calc" style={{ maxWidth: 420, marginLeft: "auto" }}>
            <span>Net of VAT</span><span>{money(gross)}</span>
            <span className="muted">of which labour (liable to CIS)</span><span className="muted">{money(labour)}</span>
            <span>VAT charged{reverseCharge ? " (reverse charge lines: none)" : ""}</span><span>{money(vatCharged)}</span>
            <span>CIS deduction{sub ? ` at ${rate * 100}%` : ""}</span><span>{deduction ? `(${money(deduction)})` : money(0)}</span>
            <span className="rule" />
            <span className="strong">Pay the subcontractor</span><span className="strong">{money(gross + vatCharged - deduction)}</span>
          </div>
          {reverseCharge && <p className="note" style={{ textAlign: "right" }}>Reverse charge: you account for the VAT on your return (boxes 1 and 4).</p>}
        </div>
      </Card>
    </form>
  );
}

export default function NewBillPage() {
  return <Suspense><BillForm /></Suspense>;
}
