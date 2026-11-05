"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AccountSelect, useAccounts, useContacts, VatSelect } from "@/components/pickers";
import { Card, ErrorBanner, Field, Loading, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { DOC_STATUS, DOC_TYPE } from "@/lib/documents";
import { dateTime, money } from "@/lib/format";

type Line =
  | { kind: "receipt"; receiptLineId: string; net?: string; vatCode?: string }
  | { kind: "account"; accountCode: string; description: string; net: string; vatCode: string };
interface Draft { kind?: "bill" | "credit"; supplierId?: string; supplierRef?: string; date?: string; dueDate?: string; currency?: string; rate?: string; lines: Line[] }
interface Extraction {
  docType: string; supplierName: string | null; supplierVatNumber: string | null; invoiceNumber: string | null; invoiceDate: string | null; dueDate: string | null;
  currency: string | null; purchaseOrderRef: string | null; containerRef: string | null; mrn: string | null; net: string | null; vat: string | null; total: string | null;
  confidence: number; notes: string[];
  lines: { description: string; quantity: string | null; unitPrice: string | null; net: string; vatRate: string | null; sku: string | null }[];
  proposal?: { supplierId: string | null; supplierName: string | null; input: Draft; matches: string[]; warnings: string[] };
}
interface Doc { id: string; filename: string; media_type: string; status: string; content?: string; extraction: Extraction | null; extractor: string | null; confidence: string | null; created_at: string; error: string | null; linked_id: string | null; bill_number: string | null }
interface Unbilled { id: string; po_number: string; sku: string; description: string; quantity: string; net: string; currency: string }

function Preview({ doc }: { doc: Doc }) {
  if (doc.content !== undefined) return <pre className="doc-preview">{doc.content}</pre>;
  if (doc.media_type.startsWith("image/")) return <img src={`/api/documents/${doc.id}/file`} alt={doc.filename} style={{ maxWidth: "100%", borderRadius: 6 }} />;
  return <iframe src={`/api/documents/${doc.id}/file`} title={doc.filename} style={{ width: "100%", height: 560, border: 0, borderRadius: 6, background: "var(--surface-sunken)" }} />;
}

export default function DocumentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: doc, error, reload } = useApi<Doc>(`/api/documents/${id}`);
  const suppliers = useContacts("supplier");
  const accounts = useAccounts((a) => !a.is_bank && (!a.is_control || a.code === "2110"));
  const [draft, setDraft] = useState<Draft | null>(null);
  const { data: unbilled } = useApi<Unbilled[]>(draft?.supplierId ? `/api/goods-receipts/unbilled?supplierId=${draft.supplierId}` : null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  useEffect(() => { if (doc?.extraction?.proposal && !draft) setDraft(structuredClone(doc.extraction.proposal.input)); }, [doc, draft]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setActionError(undefined);
    try { await fn(); } catch (e) { setActionError((e as Error).message); } finally { setBusy(false); }
  }
  const setLine = (i: number, patch: Partial<Line>) => setDraft((d) => d && ({ ...d, lines: d.lines.map((l, k) => (k === i ? { ...l, ...patch } as Line : l)) }));

  if (!doc) return <div className="stack"><ErrorBanner message={error} /><Loading /></div>;
  const x = doc.extraction;
  const p = x?.proposal;
  const done = doc.status === "converted" || doc.status === "rejected";
  const net = draft?.lines.reduce((s, l) => s + Number(l.net ?? unbilled?.find((u) => l.kind === "receipt" && u.id === l.receiptLineId)?.net ?? 0), 0) ?? 0;

  return (
    <div className="stack">
      <PageHeader title={doc.filename} subtitle={<>
        <span className={`pill ${DOC_STATUS[doc.status]?.tone ?? ""}`}>{DOC_STATUS[doc.status]?.label}</span>{" "}
        {x && <>{DOC_TYPE[x.docType]} · read by {doc.extractor === "demo-rules" ? "the built-in reader" : doc.extractor} · {Math.round(x.confidence * 100)}% confident · </>}
        received {dateTime(doc.created_at)}
        {doc.linked_id && <> · posted as <Link href={`/bills/${doc.linked_id}`}>{doc.bill_number}</Link></>}
      </>}>
        <Link className="btn ghost" href="/inbox">Back to inbox</Link>
        {!done && <button className="btn" disabled={busy} onClick={() => run(async () => { await api(`/api/documents/${id}/read`, { body: {} }); setDraft(null); await reload(); })}>Read again</button>}
      </PageHeader>
      <ErrorBanner message={actionError ?? doc.error ?? undefined} />
      <div className="grid-2">
        <Card title="The document"><div className="card-pad"><Preview doc={doc} /></div></Card>
        <div className="stack">
          {x && (
            <Card title="What was read" pad>
              <dl className="kv">
                <dt>From</dt><dd>{x.supplierName ?? "–"}{x.supplierVatNumber && <span className="muted"> · VAT GB{x.supplierVatNumber}</span>}</dd>
                <dt>Their reference</dt><dd>{x.invoiceNumber ?? "–"}</dd>
                <dt>Dated</dt><dd>{x.invoiceDate ?? "–"}{x.dueDate && <span className="muted"> · due {x.dueDate}</span>}</dd>
                {(x.purchaseOrderRef || x.containerRef || x.mrn) && <><dt>Refers to</dt><dd>{[x.purchaseOrderRef, x.containerRef, x.mrn && `MRN ${x.mrn}`].filter(Boolean).join(" · ")}</dd></>}
                <dt>Totals</dt><dd>{x.net && <>Net {money(x.net, x.currency ?? "GBP")} · </>}{x.vat && <>VAT {money(x.vat, x.currency ?? "GBP")} · </>}<strong style={{ fontWeight: 500 }}>{x.total ? money(x.total, x.currency ?? "GBP") : "–"}</strong></dd>
              </dl>
              {p && p.matches.length > 0 && <><h3 style={{ fontSize: 13, margin: "16px 0 6px" }}>Matched</h3><ul className="list-plain">{p.matches.map((m) => <li key={m}>{m}</li>)}</ul></>}
              {p && p.warnings.length > 0 && <><h3 style={{ fontSize: 13, margin: "16px 0 6px" }} className="warn">Check before posting</h3><ul className="list-plain">{p.warnings.map((w) => <li key={w}>{w}</li>)}</ul></>}
            </Card>
          )}
          {draft && !done && (
            <Card title="Draft bill" pad>
              <form className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); void run(async () => {
                const bill = await api<{ id: string }>(`/api/documents/${id}/convert`, { body: draft });
                router.push(`/bills/${bill.id}`);
              }); }}>
                <div className="grid-2" style={{ gap: 12 }}>
                  <Field label="Supplier">
                    <select value={draft.supplierId ?? ""} onChange={(e) => setDraft({ ...draft, supplierId: e.target.value || undefined })} required>
                      <option value="">Choose supplier…</option>
                      {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </Field>
                  <Field label="Their invoice number"><input value={draft.supplierRef ?? ""} onChange={(e) => setDraft({ ...draft, supplierRef: e.target.value })} required /></Field>
                  <Field label="Invoice date"><input type="date" value={draft.date ?? ""} onChange={(e) => setDraft({ ...draft, date: e.target.value })} required /></Field>
                  <Field label="Due date" hint="Blank uses the supplier's terms"><input type="date" value={draft.dueDate ?? ""} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value || undefined })} /></Field>
                  {draft.currency && draft.currency !== "GBP" && <Field label={`Rate (GBP per ${draft.currency})`} hint="Filled in from the day's reference rate"><input value={draft.rate ?? ""} onChange={(e) => setDraft({ ...draft, rate: e.target.value })} required /></Field>}
                </div>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Line</th><th>Account</th><th>VAT</th><th className="num">Net</th></tr></thead>
                    <tbody>
                      {draft.lines.map((l, i) => {
                        const r = l.kind === "receipt" ? unbilled?.find((u) => u.id === l.receiptLineId) : undefined;
                        return (
                          <tr key={i}>
                            <td style={{ whiteSpace: "normal" }}>{l.kind === "receipt" ? <>{r ? `${r.sku} ${r.description}` : "Goods received"}<br /><small className="faint">{r ? `${r.po_number}, ${Number(r.quantity)} received` : ""}</small></> :
                              <input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} aria-label="Description" />}</td>
                            <td>{l.kind === "receipt" ? <span className="muted">Clears goods received</span> : <AccountSelect accounts={accounts} value={l.accountCode} onChange={(v) => setLine(i, { accountCode: v })} />}</td>
                            <td>{l.kind === "account" ? <VatSelect value={l.vatCode} onChange={(v) => setLine(i, { vatCode: v })} /> : <span className="muted">{l.vatCode ?? "OS"}</span>}</td>
                            <td className="num"><input style={{ width: 110, textAlign: "right" }} value={l.net ?? r?.net ?? ""} onChange={(e) => setLine(i, { net: e.target.value })} aria-label="Net" /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot><tr><td colSpan={3}>Net total</td><td className="num">{money(net, draft.currency ?? "GBP")}</td></tr></tfoot>
                  </table>
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
                  <button type="button" className="btn ghost" disabled={busy} onClick={() => {
                    const reason = prompt("Why reject this document? (e.g. duplicate, not ours)");
                    if (reason) void run(async () => { await api(`/api/documents/${id}/reject`, { body: { reason } }); await reload(); });
                  }}>Reject</button>
                  <button className="btn primary" disabled={busy || !draft.supplierId}>{busy ? "Posting…" : `Post ${draft.kind === "credit" ? "credit note" : "bill"}`}</button>
                </div>
              </form>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
