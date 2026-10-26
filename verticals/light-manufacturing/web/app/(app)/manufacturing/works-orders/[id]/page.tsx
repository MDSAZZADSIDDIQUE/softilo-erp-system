"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Card, DataTable, ErrorBanner, Field, Loading, PageHeader, Stat } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date, money, qty, today } from "@/lib/format";
import { MfgStatus, unitCost } from "@mfg/components/mfg";

interface Wo {
  id: string; number: string; status: string; sku: string; name: string; uom: string; product_id: string; bom_id: string;
  bom_version: number; warehouse: string; quantity: string; completed_qty: string; scrapped_qty: string; due_date: string | null;
  wip: string; completedValue: string; actualUnitCost: string | null;
  components: { product_id: string; sku: string; name: string; uom: string; required_qty: string; issued_qty: string; outstanding: string; on_hand: string; track_stock: boolean }[];
  operations: { seq: number; description: string; work_centre_id: string; code: string; name: string }[];
  transactions: { date: string; kind: string; sku: string | null; work_centre: string | null; quantity: string | null; hours: string | null; value: string; entry_id: string | null; journal: string | null }[];
}

const KIND: Record<string, string> = {
  issue: "Material issued", labour: "Labour absorbed", overhead: "Overhead absorbed",
  complete: "Finished goods", scrap: "Scrap written off", variance: "Variance on close",
};

export default function WorksOrderPage() {
  const { id } = useParams<{ id: string }>();
  const { data: wo, error, reload } = useApi<Wo>(`/api/mfg/works-orders/${id}`);
  const { data: centres } = useApi<{ id: string; code: string; name: string }[]>("/api/mfg/work-centres");
  const [actionError, setActionError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!wo) return <div className="stack"><ErrorBanner message={error} /><Card><Loading /></Card></div>;
  const open = wo.status === "released";
  const remaining = Math.max(Number(wo.quantity) - Number(wo.completed_qty) - Number(wo.scrapped_qty), 0);
  const outstanding = wo.components.filter((c) => Number(c.outstanding) > 0);
  const short = outstanding.filter((c) => c.track_stock && Number(c.on_hand) < Number(c.outstanding));
  // Work centres on this order's routing first, then the rest.
  const routed = new Set(wo.operations.map((o) => o.work_centre_id));
  const centreOptions = [...(centres ?? [])].sort((a, b) => Number(routed.has(b.id)) - Number(routed.has(a.id)));

  async function run(path: string, body: unknown, done: (r: any) => string) {
    setBusy(true);
    try {
      const r = await api(`/api/mfg/works-orders/${id}/${path}`, { body });
      setNotice(done(r));
      setActionError(undefined);
      await reload();
    } catch (err) {
      setActionError((err as Error).message);
      setNotice(undefined);
    } finally {
      setBusy(false);
    }
  }
  const posted = (r: { journal: string | null }) => (r.journal ? ` Posted as ${r.journal}.` : "");

  return (
    <div className="stack">
      <PageHeader title={wo.number} subtitle={<>{wo.sku} · {wo.name} · BOM v{wo.bom_version} · {wo.warehouse} · due {date(wo.due_date)}</>}>
        <MfgStatus value={wo.status} />
        {wo.status === "planned" && <button className="btn primary" disabled={busy} onClick={() => run("release", {}, () => "Released to the shop floor.")}>Release</button>}
        {(wo.status === "planned" || (open && wo.transactions.length === 0)) && (
          <button className="btn ghost" disabled={busy} onClick={() => run("cancel", {}, () => "Works order cancelled.")}>Cancel order</button>
        )}
      </PageHeader>
      <ErrorBanner message={actionError} />
      {notice && <div className="banner ok" role="status">{notice}</div>}
      <div className="grid-4">
        <Stat label="To make" value={`${qty(wo.quantity)} ${wo.uom}`} sub={`${qty(remaining)} still to account for`} />
        <Stat label="Made" value={qty(wo.completed_qty)} sub={`${qty(wo.scrapped_qty)} scrapped`} />
        <Stat label="Work in progress" value={money(wo.wip)} sub="Materials, labour and overhead not yet in stock" />
        <Stat label="Actual cost per unit" value={unitCost(wo.actualUnitCost)} sub={`${money(wo.completedValue)} into finished goods`} />
      </div>

      {open && (
        <div className="shopfloor">
          <Card title="Issue materials" pad>
            <p className="muted" style={{ marginTop: 0 }}>
              {outstanding.length ? `${outstanding.length} component${outstanding.length > 1 ? "s" : ""} outstanding, issued at average cost.` : "Everything on the BOM has been issued."}
            </p>
            {short.length > 0 && <p className="banner error" style={{ marginTop: 0 }}>Not enough stock of {short.map((c) => c.sku).join(", ")}.</p>}
            <form onSubmit={(e) => {
              e.preventDefault();
              const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
              void run("issue", { date: f.date }, (r) => `Issued materials costing ${money(r.cost)}.${posted(r)}`);
            }} className="stack" style={{ gap: 12 }}>
              <Field label="Date"><input type="date" name="date" defaultValue={today()} required /></Field>
              <button className="btn primary" disabled={busy || !outstanding.length}>Issue all outstanding</button>
            </form>
          </Card>
          <Card title="Book time" pad>
            <form onSubmit={(e) => {
              e.preventDefault();
              const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
              void run("labour", { date: f.date, workCentreId: f.workCentreId, hours: f.hours },
                (r) => `Absorbed ${money(r.labour)} labour and ${money(r.overhead)} overhead.${posted(r)}`);
            }} className="stack" style={{ gap: 12 }}>
              <Field label="Work centre">
                <select name="workCentreId" required>
                  {centreOptions.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}
                </select>
              </Field>
              <div className="grid-2" style={{ gap: 12 }}>
                <Field label="Hours"><input name="hours" className="num" inputMode="decimal" required placeholder="1.5" /></Field>
                <Field label="Date"><input type="date" name="date" defaultValue={today()} required /></Field>
              </div>
              <button className="btn primary" disabled={busy || !centres?.length}>Book time</button>
            </form>
          </Card>
          <Card title="Complete" pad>
            <form onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
              void run("complete", { date: f.date, quantity: f.quantity || "0", scrapQuantity: f.scrap || "0", close: f.close === "on" },
                (r) => `${money(r.finishedGoods)} into finished goods${Number(r.scrap) ? `, ${money(r.scrap)} scrap written off` : ""}${Number(r.variance) ? `, ${money(r.variance)} to production variances` : ""}.${r.closed ? " Order closed." : ""}${posted(r)}`)
                .then(() => form.reset());
            }} className="stack" style={{ gap: 12 }}>
              <div className="grid-2" style={{ gap: 12 }}>
                <Field label="Good units"><input name="quantity" className="num" inputMode="decimal" placeholder={String(remaining)} /></Field>
                <Field label="Scrapped units"><input name="scrap" className="num" inputMode="decimal" placeholder="0" /></Field>
              </div>
              <Field label="Date"><input type="date" name="date" defaultValue={today()} required /></Field>
              <label className="checkbox"><input type="checkbox" name="close" /> Close the order (clears all remaining WIP)</label>
              <button className="btn accent" disabled={busy}>Complete into stock</button>
            </form>
          </Card>
        </div>
      )}

      <Card title="Components">
        <DataTable rows={wo.components} columns={[
          { key: "s", label: "Component", render: (c) => <Link href={`/products/${c.product_id}`}>{c.sku}</Link> },
          { key: "n", label: "Name", render: (c) => c.name },
          { key: "r", label: "Required", num: true, render: (c) => `${qty(c.required_qty)} ${c.uom}` },
          { key: "i", label: "Issued", num: true, render: (c) => qty(c.issued_qty) },
          { key: "o", label: "Outstanding", num: true, render: (c) => qty(c.outstanding) },
          { key: "h", label: `On hand (${wo.warehouse})`, num: true, render: (c) => c.track_stock
            ? <span className={Number(c.on_hand) < Number(c.outstanding) ? "pill signal" : undefined}>{qty(c.on_hand)}</span>
            : <span className="muted">Not stocked</span> },
        ]} />
      </Card>

      <Card title="Cost history" actions={<span className="muted">Every line is part of a balanced journal</span>}>
        <DataTable rows={wo.transactions} empty={<div className="card-pad muted">Nothing posted yet.</div>} columns={[
          { key: "d", label: "Date", render: (t) => date(t.date) },
          { key: "k", label: "What", render: (t) => KIND[t.kind] ?? t.kind },
          { key: "i", label: "Item / centre", render: (t) => t.sku ?? t.work_centre ?? "–" },
          { key: "q", label: "Quantity / hours", num: true, render: (t) => t.hours ? `${qty(t.hours)} h` : t.quantity ? qty(t.quantity) : "–" },
          { key: "v", label: "WIP movement", num: true, render: (t) => money(t.value) },
          { key: "j", label: "Journal", render: (t) => t.entry_id ? <Link href={`/journals/${t.entry_id}`}>{t.journal}</Link> : <span className="muted">No value</span> },
        ]} />
      </Card>
    </div>
  );
}
