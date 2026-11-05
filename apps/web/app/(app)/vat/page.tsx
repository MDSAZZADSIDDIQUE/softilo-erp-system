"use client";

import { useState } from "react";
import { Card, DataTable, ErrorBanner, Field, PageHeader, Status, Tabs } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date, money, today } from "@/lib/format";

interface Boxes { box1: string; box2: string; box3: string; box4: string; box5: string; box6: string; box7: string; box8: string; box9: string }
interface Preview { from: string; to: string; boxes: Boxes; entries: number; lateEntries: number; byCode: { direction: string; vat_code: string; entries: string; net: string; vat: string }[] }
interface VatReturn { id: string; period_key: string; start_date: string; end_date: string; boxes: Boxes; status: string; journal_number: string; created_at: string;
  submitted_at: string | null; submission_mode: string | null; hmrc_receipt: { formBundleNumber: string; chargeRefNumber?: string; processingDate: string } | null }
interface Obligation { periodKey: string; start: string; end: string; due: string; status: "O" | "F"; received?: string; returnId: string | null; returnStatus: string | null }

/** What HMRC's fraud-prevention rules ask the browser for (Gov-Client-* headers). Sent with each submission. */
function fraudData() {
  let deviceId = "";
  try {
    deviceId = localStorage.getItem("softilo-device-id") ?? "";
    if (!deviceId) { deviceId = crypto.randomUUID(); localStorage.setItem("softilo-device-id", deviceId); }
  } catch { deviceId = crypto.randomUUID(); }
  const offset = -new Date().getTimezoneOffset();
  const tz = `UTC${offset >= 0 ? "+" : "-"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
  return {
    deviceId, timezone: tz, userAgent: navigator.userAgent, doNotTrack: navigator.doNotTrack === "1" ? "true" : "false",
    screens: `width=${screen.width}&height=${screen.height}&scaling-factor=${window.devicePixelRatio}&colour-depth=${screen.colorDepth}`,
    windowSize: `width=${window.innerWidth}&height=${window.innerHeight}`,
  };
}

function Obligations({ onUse, reloadKey }: { onUse: (o: Obligation) => void; reloadKey: number }) {
  const { data, error, reload } = useApi<Obligation[]>(`/api/vat/obligations?k=${reloadKey}`);
  const [connectError, setConnectError] = useState<string>();
  const notConnected = error && /Connect Softilo to HMRC/.test(error);
  async function connect() {
    try {
      const r = await api<{ redirect?: string }>("/api/integrations/hmrc/connect", { body: {} });
      if (r.redirect) window.location.href = r.redirect; else await reload();
    } catch (e) { setConnectError((e as Error).message); }
  }
  return (
    <Card title="HMRC obligations" actions={notConnected ? <button className="btn small primary" onClick={() => void connect()}>Connect to HMRC</button> : undefined}>
      <ErrorBanner message={connectError ?? (notConnected ? undefined : error)} />
      {notConnected ? <p className="muted card-pad" style={{ margin: 0 }}>Connect to HMRC to see which periods are due and to file returns under Making Tax Digital.</p> : (
        <DataTable rows={data} columns={[
          { key: "k", label: "Period", render: (o) => <span className="mono">{o.periodKey}</span> },
          { key: "p", label: "Covers", render: (o) => `${date(o.start)} – ${date(o.end)}` },
          { key: "d", label: "Due", render: (o) => <span className={o.status === "O" && o.due < today() ? "warn" : undefined}>{date(o.due)}</span> },
          { key: "s", label: "HMRC", render: (o) => (o.status === "F" ? <span className="pill quiet ok">Filed{o.received ? ` ${date(o.received)}` : ""}</span> : <span className="pill">Open</span>) },
          { key: "a", label: "", num: true, render: (o) => o.status === "O" && !o.returnId && o.end < today() ? <button className="btn small" onClick={() => onUse(o)}>Prepare</button>
            : o.returnStatus === "finalised" ? <span className="muted">Finalised, ready to submit</span>
            : o.status === "O" && o.end >= today() ? <span className="faint">Period not ended</span> : null },
        ]} />
      )}
    </Card>
  );
}
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
  const [periodKey, setPeriodKey] = useState("");
  const [obligationsKey, setObligationsKey] = useState(0);

  async function submit(r: VatReturn) {
    const ok = confirm(`Submit the ${r.period_key} return to HMRC?\n\nDeclaration: When you submit this VAT information you are making a legal declaration that the information is true and complete. A false declaration can result in prosecution.\n\nBox 5: ${money(r.boxes.box5)}`);
    if (!ok) return;
    try {
      const res = await api<{ receipt: { formBundleNumber: string; chargeRefNumber?: string }; mode: string }>(`/api/vat/returns/${r.id}/submit`, { body: { declaration: true, fraud: fraudData() } });
      setMsg(`${r.period_key} submitted${res.mode === "demo" ? " to the HMRC simulator" : " to HMRC"}. Receipt ${res.receipt.formBundleNumber}${res.receipt.chargeRefNumber ? `, payment reference ${res.receipt.chargeRefNumber}` : ""}.`);
      setActionError(undefined);
      setObligationsKey((k) => k + 1);
      await reloadReturns();
    } catch (err) {
      setActionError((err as Error).message);
    }
  }

  async function finalise(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    if (!confirm(`Finalise this VAT return? Transactions up to ${date(period.to)} will be locked.`)) return;
    try {
      await api("/api/vat/returns", { body: { periodKey: f.periodKey, from: period.from, to: period.to, lockBooks: true } });
      setMsg("Return finalised and the period locked. Submit it to HMRC from Past returns.");
      setObligationsKey((k) => k + 1);
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

      {tab === "return" && <Obligations reloadKey={obligationsKey} onUse={(o) => { setPeriod({ from: o.start, to: o.end }); setPeriodKey(o.periodKey); }} />}
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
                <Field label="HMRC period key" hint="Filled in when you prepare an obligation above"><input name="periodKey" required maxLength={10} value={periodKey} onChange={(e) => setPeriodKey(e.target.value)} /></Field>
                <button className="btn primary" disabled={!preview?.entries}>Finalise and lock period</button>
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
            { key: "h", label: "HMRC", render: (r) => r.status === "submitted"
              ? <span className="muted">{r.submission_mode === "demo" ? "Simulator" : "Filed"} {date(r.submitted_at)}<br /><small className="faint">Receipt {r.hmrc_receipt?.formBundleNumber}</small></span>
              : <button className="btn small primary" onClick={() => void submit(r)}>Submit to HMRC</button> },
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
