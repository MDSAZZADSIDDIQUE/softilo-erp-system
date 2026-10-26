"use client";

import { useState } from "react";
import { Card, DataTable, ErrorBanner, Field, PageHeader, Status, Tabs } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date, money, today } from "@/lib/format";

interface Boxes { box1: string; box2: string; box3: string; box4: string; box5: string; box6: string; box7: string; box8: string; box9: string }
interface Preview { from: string; to: string; boxes: Boxes; entries: number; lateEntries: number; byCode: { direction: string; vat_code: string; entries: string; net: string; vat: string }[] }
interface VatReturn { id: string; period_key: string; start_date: string; end_date: string; boxes: Boxes; status: string; journal_number: string; created_at: string }
interface Pva { id: string; statement: string; mrn: string; date: string; value_gbp: string; vat_gbp: string; shipment_number: string | null }

const BOX_LABELS: [keyof Boxes, string][] = [
  ["box1", "VAT due on sales and other outputs"],
  ["box2", "VAT due on acquisitions from the EU (Northern Ireland only)"],
  ["box3", "Total VAT due"],
  ["box4", "VAT reclaimed on purchases and other inputs"],
  ["box5", "Net VAT to pay to HMRC or reclaim"],
  ["box6", "Total value of sales, excluding VAT"],
  ["box7", "Total value of purchases, excluding VAT"],
  ["box8", "Supplies of goods to the EU (Northern Ireland only)"],
  ["box9", "Acquisitions of goods from the EU (Northern Ireland only)"],
];

function quarterBounds(): { from: string; to: string } {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3);
  const from = new Date(now.getFullYear(), q * 3, 1);
  const to = new Date(now.getFullYear(), q * 3 + 3, 0);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: iso(from), to: iso(to) };
}

function BoxTable({ boxes }: { boxes: Boxes }) {
  return (
    <div className="table-wrap">
    <table className="data">
      <tbody>
        {BOX_LABELS.map(([k, label]) => (
          <tr key={k} style={k === "box5" ? { background: "var(--surface-sunken)" } : undefined}>
            <td style={{ width: 70 }} className="muted">Box {k.slice(3)}</td>
            <td style={{ whiteSpace: "normal" }}>{label}</td>
            <td className="num" style={k === "box5" ? { fontWeight: 500, fontSize: 16 } : undefined}>
              {Number(k.slice(3)) >= 6 ? `£${Number(boxes[k]).toLocaleString("en-GB")}` : money(boxes[k])}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

export default function VatPage() {
  const [tab, setTab] = useState("return");
  const [period, setPeriod] = useState(quarterBounds());
  const { data: preview, error, reload } = useApi<Preview>(`/api/vat/preview?from=${period.from}&to=${period.to}`);
  const { data: returns, reload: reloadReturns } = useApi<VatReturn[]>("/api/vat/returns");
  const { data: pva, reload: reloadPva } = useApi<Pva[]>("/api/vat/pva");
  const [msg, setMsg] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  async function finalise(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    if (!confirm(`Finalise this VAT return? Transactions up to ${date(period.to)} will be locked.`)) return;
    try {
      await api("/api/vat/returns", { body: { periodKey: f.periodKey, from: period.from, to: period.to, lockBooks: true } });
      setMsg("Return finalised and the period locked. Submit it to HMRC once the MTD connection is set up.");
      setActionError(undefined);
      await Promise.all([reload(), reloadReturns()]);
    } catch (err) {
      setActionError((err as Error).message);
    }
  }

  async function addPva(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    try {
      const r = await api<{ unmatched: string[] }>("/api/vat/pva", {
        body: { statement: f.statement, entries: [{ mrn: f.mrn, date: f.date, valueGbp: f.valueGbp, vatGbp: f.vatGbp }] },
      });
      setMsg(r.unmatched.length ? `Recorded. MRN ${r.unmatched.join(", ")} isn't on any shipment yet.` : "Recorded and matched to its shipment.");
      setActionError(undefined);
      form.reset();
      await Promise.all([reloadPva(), reload()]);
    } catch (err) {
      setActionError((err as Error).message);
    }
  }

  return (
    <div className="stack">
      <PageHeader title="VAT" subtitle="Your 9-box return, built from every posting, including postponed import VAT." />
      {msg && <div className="banner ok">{msg}</div>}
      <ErrorBanner message={actionError ?? error} />
      <Tabs active={tab} onChange={setTab} tabs={[{ id: "return", label: "Current return" }, { id: "history", label: "Past returns" }, { id: "pva", label: "Postponed import VAT" }]} />

      {tab === "return" && (
        <div className="grid-main">
          <Card title="Return preview" actions={
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input type="date" value={period.from} onChange={(e) => setPeriod({ ...period, from: e.target.value })} aria-label="From" />
              <span className="muted">to</span>
              <input type="date" value={period.to} onChange={(e) => setPeriod({ ...period, to: e.target.value })} aria-label="To" />
            </div>
          }>
            {preview && <BoxTable boxes={preview.boxes} />}
          </Card>
          <div className="stack">
            <Card title="Finalise" pad>
              {preview && <p className="muted" style={{ marginTop: 0 }}>
                {preview.entries} VAT transactions not yet on a return{preview.lateEntries ? `, including ${preview.lateEntries} dated before this period (they roll in here)` : ""}.
              </p>}
              <form onSubmit={finalise} className="stack" style={{ gap: 12 }}>
                <Field label="HMRC period key" hint="From your VAT obligations, e.g. 26C3"><input name="periodKey" required maxLength={10} /></Field>
                <button className="btn primary" disabled={!preview?.entries}>Finalise and lock period</button>
                <button type="button" className="btn" disabled title="Needs the HMRC MTD connection">Submit to HMRC</button>
              </form>
            </Card>
            <Card title="By VAT code">
              <DataTable rows={preview?.byCode} columns={[
                { key: "d", label: "", render: (r) => r.direction === "sales" ? "Sales" : "Purchases" },
                { key: "c", label: "Code", render: (r) => r.vat_code },
                { key: "n", label: "Net", num: true, render: (r) => money(r.net) },
                { key: "v", label: "VAT", num: true, render: (r) => money(r.vat) },
              ]} />
            </Card>
          </div>
        </div>
      )}

      {tab === "history" && (
        <Card>
          <DataTable rows={returns} columns={[
            { key: "k", label: "Period", render: (r) => r.period_key },
            { key: "p", label: "Covers", render: (r) => `${date(r.start_date)} – ${date(r.end_date)}` },
            { key: "s", label: "Status", render: (r) => <Status value={r.status} /> },
            { key: "1", label: "Box 1", num: true, render: (r) => money(r.boxes.box1) },
            { key: "4", label: "Box 4", num: true, render: (r) => money(r.boxes.box4) },
            { key: "5", label: "Box 5", num: true, render: (r) => <strong style={{ fontWeight: 500 }}>{money(r.boxes.box5)}</strong> },
            { key: "j", label: "Journal", render: (r) => r.journal_number },
          ]} />
        </Card>
      )}

      {tab === "pva" && (
        <div className="stack">
          <Card title="Add from your monthly PVA statement" pad>
            <p className="muted" style={{ marginTop: 0 }}>Download the statement from the Customs Declaration Service. Import VAT goes into boxes 1 and 4 and the value into box 7, so it costs you nothing in cash.</p>
            <form onSubmit={addPva} className="form-grid" style={{ alignItems: "end" }}>
              <Field label="Statement month"><input name="statement" type="month" defaultValue={today().slice(0, 7)} required /></Field>
              <Field label="MRN"><input name="mrn" required /></Field>
              <Field label="Import date"><input name="date" type="date" defaultValue={today()} required /></Field>
              <Field label="Customs value (£)"><input name="valueGbp" className="num" inputMode="decimal" required /></Field>
              <Field label="Import VAT (£)"><input name="vatGbp" className="num" inputMode="decimal" required /></Field>
              <button className="btn primary">Record</button>
            </form>
          </Card>
          <Card>
            <DataTable rows={pva} columns={[
              { key: "s", label: "Statement", render: (p) => p.statement },
              { key: "m", label: "MRN", render: (p) => <span className="mono">{p.mrn}</span> },
              { key: "d", label: "Date", render: (p) => date(p.date) },
              { key: "sh", label: "Shipment", render: (p) => p.shipment_number ?? <span className="pill signal">Unmatched</span> },
              { key: "v", label: "Value", num: true, render: (p) => money(p.value_gbp) },
              { key: "vat", label: "Import VAT", num: true, render: (p) => money(p.vat_gbp) },
            ]} />
          </Card>
        </div>
      )}
    </div>
  );
}
