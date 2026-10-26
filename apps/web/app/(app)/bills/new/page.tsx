"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AccountSelect, useAccounts, useContacts, VatSelect } from "@/components/pickers";
import { Card, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { money, qty, roundHalfUp, sumPence, today, VAT_RATE } from "@/lib/format";

interface Unbilled { id: string; receipt_number: string; po_number: string; description: string; sku: string; quantity: string; net: string; vat_code: string; currency: string }
interface AccountLine { accountCode: string; description: string; net: string; vatCode: string }

export default function NewBillPage() {
  const router = useRouter();
  const params = useSearchParams();
  const kind = params.get("kind") === "credit" ? "credit" : "bill";
  const suppliers = useContacts("supplier");
  const accounts = useAccounts((a) => !a.is_control && !a.is_bank);
  const [supplierId, setSupplierId] = useState(params.get("supplierId") ?? "");
  const supplier = suppliers.find((s) => s.id === supplierId);
  const currency = supplier?.currency ?? "GBP";
  const { data: unbilled } = useApi<Unbilled[]>(supplierId && kind === "bill" ? `/api/goods-receipts/unbilled?supplierId=${supplierId}` : null);
  const [picked, setPicked] = useState<Record<string, { net: string; vatCode: string }>>({});
  const [lines, setLines] = useState<AccountLine[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => setPicked({}), [supplierId]);
  useEffect(() => { if (kind === "credit" && !lines.length) setLines([{ accountCode: "", description: "", net: "", vatCode: "S20" }]); }, [kind, lines.length]);

  const vatOf = (net: string, code: string) => code === "RC20" ? 0 : roundHalfUp(Number(net || 0) * (VAT_RATE[code] ?? 0));
  const all = [...Object.values(picked), ...lines];
  const net = sumPence(all.map((l) => l.net));
  const vat = sumPence(all.map((l) => vatOf(l.net, l.vatCode)));

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    try {
      const { id } = await api("/api/supplier-bills", {
        body: {
          kind, supplierId, supplierRef: f.supplierRef, date: f.date, dueDate: f.dueDate || undefined,
          rate: currency === "GBP" ? undefined : f.rate,
          lines: [
            ...Object.entries(picked).map(([receiptLineId, l]) => ({ kind: "receipt", receiptLineId, net: l.net, vatCode: l.vatCode })),
            ...lines.filter((l) => l.accountCode).map((l) => ({ kind: "account", ...l })),
          ],
        },
      });
      router.push(`/bills/${id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <PageHeader title={kind === "credit" ? "New supplier credit" : "New supplier bill"}
        subtitle={kind === "bill" ? "Match goods received, or code freight, duty and overheads to an account. Use Landed cost clearing (2110) for freight and duty you'll land on a shipment." : undefined}>
        <button type="button" className="btn ghost" onClick={() => router.back()}>Cancel</button>
        <button className="btn primary" disabled={busy || !supplierId || !all.length}>Post {kind}</button>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card title="Bill" pad>
        <div className="form-grid">
          <Field label="Supplier">
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
              <option value="">Choose supplier…</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.currency})</option>)}
            </select>
          </Field>
          <Field label="Supplier's reference"><input name="supplierRef" required /></Field>
          <Field label="Bill date"><input type="date" name="date" defaultValue={today()} required /></Field>
          <Field label="Due date" hint={supplier ? `Defaults to ${supplier.payment_terms_days} days` : undefined}><input type="date" name="dueDate" /></Field>
          {currency !== "GBP" && <Field label={`Rate (GBP per 1 ${currency})`}><input name="rate" className="num" inputMode="decimal" required /></Field>}
        </div>
      </Card>
      {kind === "bill" && supplierId && (
        <Card title="Goods received, not yet billed">
          {!unbilled?.length ? <p className="muted card-pad" style={{ margin: 0 }}>Nothing awaiting a bill from this supplier.</p> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th /><th>Receipt</th><th>PO</th><th>Item</th><th className="num">Qty</th><th className="num">Net ({currency})</th><th>VAT</th></tr></thead>
                <tbody>
                  {unbilled.map((u) => {
                    const p = picked[u.id];
                    return (
                      <tr key={u.id}>
                        <td><input type="checkbox" aria-label={`Bill ${u.description}`} checked={Boolean(p)} onChange={(e) => {
                          const next = { ...picked };
                          if (e.target.checked) next[u.id] = { net: Number(u.net).toFixed(2), vatCode: u.vat_code }; else delete next[u.id];
                          setPicked(next);
                        }} /></td>
                        <td>{u.receipt_number}</td><td>{u.po_number}</td><td>{u.sku} · {u.description}</td>
                        <td className="num">{qty(u.quantity)}</td>
                        <td className="num" style={{ width: 140 }}>{p
                          ? <input className="num" value={p.net} aria-label="Net" onChange={(e) => setPicked({ ...picked, [u.id]: { ...p, net: e.target.value } })} />
                          : money(u.net, currency)}</td>
                        <td style={{ width: 170 }}>{p ? <VatSelect value={p.vatCode} onChange={(v) => setPicked({ ...picked, [u.id]: { ...p, vatCode: v } })} /> : u.vat_code}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      <Card title="Other lines" actions={<button type="button" className="btn small" onClick={() => setLines((ls) => [...ls, { accountCode: "", description: "", net: "", vatCode: "S20" }])}>Add line</button>}>
        {!lines.length ? <p className="muted card-pad" style={{ margin: 0 }}>Freight, duty, rent, services…</p> : (
          <div className="table-wrap card-pad">
            <table className="lines">
              <thead><tr><th>Account</th><th>Description</th><th>Net</th><th>VAT</th><th /></tr></thead>
              <tbody>
                {lines.map((l, i) => {
                  const set = (patch: Partial<AccountLine>) => setLines((ls) => ls.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                  return (
                    <tr key={i}>
                      <td style={{ width: "30%" }}><AccountSelect accounts={accounts} value={l.accountCode} onChange={(v) => set({ accountCode: v })} /></td>
                      <td><input value={l.description} aria-label="Description" onChange={(e) => set({ description: e.target.value })} required /></td>
                      <td style={{ width: 130 }}><input className="num" inputMode="decimal" aria-label="Net" value={l.net} onChange={(e) => set({ net: e.target.value })} required /></td>
                      <td style={{ width: 170 }}><VatSelect value={l.vatCode} onChange={(v) => set({ vatCode: v })} /></td>
                      <td><button type="button" className="btn ghost small" aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>×</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="totals">
          <span className="muted">Net</span><span>{money(net, currency)}</span>
          <span className="muted">VAT</span><span>{money(vat, currency)}</span>
          <span className="grand">Total</span><span className="grand">{money(net + vat, currency)}</span>
        </div>
      </Card>
    </form>
  );
}
