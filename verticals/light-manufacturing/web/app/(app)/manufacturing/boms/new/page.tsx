"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useProducts } from "@/components/pickers";
import { Card, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";

interface Line { componentId: string; quantity: string; wastagePct: string }
interface Op { workCentreId: string; description: string; setupHours: string; runHoursPerUnit: string }
interface WorkCentre { id: string; code: string; name: string }
interface Existing {
  product_id: string; output_qty: string;
  lines: { component_id: string; quantity: string; wastage_pct: string }[];
  operations: { work_centre_id: string; description: string; setup_hours: string; run_hours_per_unit: string }[];
}

const blankLine = (): Line => ({ componentId: "", quantity: "1", wastagePct: "0" });
const blankOp = (): Op => ({ workCentreId: "", description: "", setupHours: "0", runHoursPerUnit: "0" });
const trim = (v: string) => (v.includes(".") ? v.replace(/\.?0+$/, "") : v);

function NewBomForm() {
  const router = useRouter();
  const from = useSearchParams().get("from");
  const products = useProducts();
  const { data: centres } = useApi<WorkCentre[]>("/api/mfg/work-centres");
  const { data: existing } = useApi<Existing>(from ? `/api/mfg/boms/${from}` : null);
  const [productId, setProductId] = useState("");
  const [outputQty, setOutputQty] = useState("1");
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [ops, setOps] = useState<Op[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // "New version" starts from the existing BOM.
  useEffect(() => {
    if (!existing) return;
    setProductId(existing.product_id);
    setOutputQty(trim(existing.output_qty));
    setLines(existing.lines.map((l) => ({ componentId: l.component_id, quantity: trim(l.quantity), wastagePct: trim(l.wastage_pct) })));
    setOps(existing.operations.map((o) => ({
      workCentreId: o.work_centre_id, description: o.description, setupHours: trim(o.setup_hours), runHoursPerUnit: trim(o.run_hours_per_unit),
    })));
  }, [existing]);

  const updateLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const updateOp = (i: number, p: Partial<Op>) => setOps((os) => os.map((o, j) => (j === i ? { ...o, ...p } : o)));

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      const { id } = await api("/api/mfg/boms", {
        body: {
          productId, outputQty, activate: true,
          lines: lines.filter((l) => l.componentId),
          operations: ops.filter((o) => o.workCentreId),
        },
      });
      router.push(`/manufacturing/boms/${id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <PageHeader title={from ? "New BOM version" : "New bill of materials"}
        subtitle="Saving makes this the active version. Works orders already raised keep the version they were planned with.">
        <button type="button" className="btn ghost" onClick={() => router.back()}>Cancel</button>
        <button className="btn primary" disabled={busy || !productId}>Save and activate</button>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card title="Product" pad>
        <div className="form-grid">
          <Field label="Product made">
            <select value={productId} onChange={(e) => setProductId(e.target.value)} required disabled={Boolean(from)}>
              <option value="">Choose product…</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}
            </select>
          </Field>
          <Field label="Batch size" hint="How many units these quantities make">
            <input className="num" inputMode="decimal" value={outputQty} onChange={(e) => setOutputQty(e.target.value)} required />
          </Field>
        </div>
      </Card>
      <Card title="Components">
        <div className="table-wrap card-pad">
          <table className="lines">
            <thead><tr><th style={{ width: "55%" }}>Component</th><th>Quantity per batch</th><th>Wastage %</th><th /></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    <select value={l.componentId} aria-label="Component" onChange={(e) => updateLine(i, { componentId: e.target.value })}>
                      <option value="">Choose component…</option>
                      {products.filter((p) => p.id !== productId).map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}
                    </select>
                  </td>
                  <td><input className="num" inputMode="decimal" aria-label="Quantity" value={l.quantity} onChange={(e) => updateLine(i, { quantity: e.target.value })} /></td>
                  <td><input className="num" inputMode="decimal" aria-label="Wastage percentage" value={l.wastagePct} onChange={(e) => updateLine(i, { wastagePct: e.target.value })} /></td>
                  <td><button type="button" className="btn ghost small" aria-label="Remove component" disabled={lines.length === 1}
                    onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>×</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="btn small" style={{ marginTop: 12 }} onClick={() => setLines((ls) => [...ls, blankLine()])}>Add component</button>
        </div>
      </Card>
      <Card title="Routing">
        <div className="table-wrap card-pad">
          {ops.length > 0 && (
            <table className="lines">
              <thead><tr><th>Work centre</th><th style={{ width: "35%" }}>Operation</th><th>Setup hours (per batch)</th><th>Run hours (per unit)</th><th /></tr></thead>
              <tbody>
                {ops.map((o, i) => (
                  <tr key={i}>
                    <td>
                      <select value={o.workCentreId} aria-label="Work centre" onChange={(e) => updateOp(i, { workCentreId: e.target.value })}>
                        <option value="">Choose…</option>
                        {centres?.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}
                      </select>
                    </td>
                    <td><input aria-label="Operation" value={o.description} required onChange={(e) => updateOp(i, { description: e.target.value })} placeholder="Assemble and test" /></td>
                    <td><input className="num" inputMode="decimal" aria-label="Setup hours" value={o.setupHours} onChange={(e) => updateOp(i, { setupHours: e.target.value })} /></td>
                    <td><input className="num" inputMode="decimal" aria-label="Run hours per unit" value={o.runHoursPerUnit} onChange={(e) => updateOp(i, { runHoursPerUnit: e.target.value })} /></td>
                    <td><button type="button" className="btn ghost small" aria-label="Remove operation" onClick={() => setOps((os) => os.filter((_, j) => j !== i))}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!centres?.length && <p className="muted">Add work centres first to cost labour and overhead.</p>}
          <button type="button" className="btn small" style={{ marginTop: 12 }} disabled={!centres?.length} onClick={() => setOps((os) => [...os, blankOp()])}>Add operation</button>
        </div>
      </Card>
    </form>
  );
}

export default function NewBomPage() {
  return <Suspense><NewBomForm /></Suspense>;
}
