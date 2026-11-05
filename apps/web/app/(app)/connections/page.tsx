"use client";

import { useState } from "react";
import { Card, ErrorBanner, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { dateTime } from "@/lib/format";

interface Info { mode: "demo" | "live"; name: string; ready: boolean; missing?: string[]; model?: string | null }
interface Connection { id: string; provider: string; mode: string; status: string; label: string | null; external_ref: string | null; account_code: string | null; expires_at: string | null; last_synced_at: string | null; last_error: string | null }
interface Data { providers: Record<string, Info>; connections: Connection[] }

const SERVICES: { key: string; title: string; what: string; env: string; provider?: string }[] = [
  { key: "hmrc", title: "HMRC Making Tax Digital", what: "Reads your VAT obligations and files returns.", env: "HMRC_MODE, HMRC_CLIENT_ID, HMRC_CLIENT_SECRET", provider: "hmrc_vat" },
  { key: "bankFeed", title: "Bank feed (Open Banking)", what: "Brings bank transactions in every hour, through TrueLayer.", env: "BANK_FEED_MODE, TRUELAYER_CLIENT_ID, TRUELAYER_CLIENT_SECRET", provider: "bank_feed" },
  { key: "ai", title: "AI (Google Gemini)", what: "Reads invoices and answers questions about the books. Never posts.", env: "GEMINI_API_KEY, GEMINI_MODEL" },
  { key: "companiesHouse", title: "Companies House", what: "Looks up and checks customers and suppliers.", env: "COMPANIES_HOUSE_MODE, COMPANIES_HOUSE_API_KEY" },
  { key: "vatCheck", title: "HMRC VAT number check", what: "Confirms a supplier's VAT number before you reclaim VAT on its invoices.", env: "VAT_CHECK_MODE (uses the HMRC credentials)" },
  { key: "email", title: "Email (Postmark)", what: "Sends invoices, statements and payment reminders.", env: "EMAIL_MODE, POSTMARK_SERVER_TOKEN, EMAIL_FROM" },
  { key: "fx", title: "Exchange rates", what: "Daily reference rates for orders and bills in other currencies.", env: "FX_MODE (ECB rates, no key needed)" },
];

export default function ConnectionsPage() {
  const { data, error, reload } = useApi<Data>("/api/integrations");
  const [actionError, setActionError] = useState<string>();
  const [msg, setMsg] = useState<string>();

  async function connect(provider: string) {
    setActionError(undefined);
    try {
      const r = await api<{ redirect?: string }>(provider === "hmrc_vat" ? "/api/integrations/hmrc/connect" : "/api/integrations/bank/connect",
        { body: provider === "hmrc_vat" ? {} : { bankAccountCode: "1200" } });
      if (r.redirect) { window.location.href = r.redirect; return; }
      setMsg("Connected.");
      await reload();
    } catch (e) { setActionError((e as Error).message); }
  }
  async function disconnect(id: string) {
    if (!confirm("Disconnect? Softilo will stop using this connection until you connect again.")) return;
    try { await api(`/api/integrations/${id}/disconnect`, { body: {} }); await reload(); } catch (e) { setActionError((e as Error).message); }
  }

  return (
    <div className="stack">
      <PageHeader title="Connections" subtitle="The outside services Softilo works with. Each runs on a built-in demo service until it is switched to live in the server's settings, so you can try everything first and then move to real data without changing how you work." />
      {msg && <div className="banner ok">{msg}</div>}
      <ErrorBanner message={actionError ?? error} />
      <div className="grid-2">
        {data && SERVICES.map((s) => {
          const info = data.providers[s.key];
          if (!info) return null;
          const conns = s.provider ? data.connections.filter((c) => c.provider === s.provider) : [];
          const live = info.mode === "live";
          return (
            <Card key={s.key} title={s.title} actions={<span className={`pill ${live ? (info.ready ? "solid" : "signal") : "quiet"}`}>{live ? (info.ready ? "Live" : "Live, not set up") : "Demo"}</span>}>
              <div className="card-pad stack" style={{ gap: 10 }}>
                <p className="muted" style={{ margin: 0 }}>{s.what}</p>
                <dl className="kv">
                  <dt>Service</dt><dd>{info.name}{info.model ? ` · ${info.model}` : ""}</dd>
                  {live && !info.ready && <><dt>Needs</dt><dd className="warn">{info.missing?.join(", ")}</dd></>}
                  <dt>Settings</dt><dd className="faint" style={{ fontSize: 12 }}>{s.env}</dd>
                </dl>
                {conns.map((c) => (
                  <div key={c.id} className="banner" style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                    <span>
                      <span className={`pill ${c.status === "connected" ? "quiet ok" : "signal"}`}>{c.status === "connected" ? "Connected" : c.status}</span>{" "}
                      {c.label}{c.account_code ? ` → ${c.account_code}` : ""}
                      <br /><small className="faint">{c.mode === "demo" ? "Demo" : "Live"}{c.last_synced_at ? ` · last synced ${dateTime(c.last_synced_at)}` : ""}{c.expires_at ? ` · consent until ${dateTime(c.expires_at)}` : ""}</small>
                      {c.last_error && <><br /><small className="warn">{c.last_error}</small></>}
                    </span>
                    <button className="btn small ghost" onClick={() => void disconnect(c.id)}>Disconnect</button>
                  </div>
                ))}
                {s.provider && !conns.some((c) => c.status === "connected") && (
                  <div><button className="btn primary small" disabled={live && !info.ready} onClick={() => void connect(s.provider!)}>
                    {s.provider === "hmrc_vat" ? "Connect to HMRC" : "Connect bank account 1200"}
                  </button></div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
