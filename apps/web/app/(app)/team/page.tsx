"use client";

import { useState } from "react";
import { Card, DataTable, ErrorBanner, Field, PageHeader } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { date } from "@/lib/format";

interface Team { members: { id: string; name: string; email: string; role: string; created_at: string; mfa_enabled: boolean }[]; roles: { id: string; help: string }[] }
interface Mfa { enabled: boolean; enabledAt: string | null; recoveryCodesLeft: number }
interface Me { id: string; role: string }

function TwoFactor() {
  const { data, reload } = useApi<Mfa>("/api/auth/mfa");
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string }>();
  const [codes, setCodes] = useState<string[]>();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const run = async (fn: () => Promise<void>) => { setError(undefined); try { await fn(); } catch (e) { setError((e as Error).message); } };

  return (
    <Card title="Two-factor sign-in" pad>
      <ErrorBanner message={error} />
      {codes ? (
        <div className="stack" style={{ gap: 12 }}>
          <p style={{ margin: 0 }}>Two-factor sign-in is on. Keep these recovery codes somewhere safe: each works once if you lose your phone. They will not be shown again.</p>
          <div className="code-box">{codes.join("   ")}</div>
          <div><button className="btn" onClick={() => { setCodes(undefined); void reload(); }}>I have saved them</button></div>
        </div>
      ) : data?.enabled ? (
        <form className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); void run(async () => { await api("/api/auth/mfa/disable", { body: { code } }); setCode(""); await reload(); }); }}>
          <p style={{ margin: 0 }}><span className="pill quiet ok">On</span> since {date(data.enabledAt)}. {data.recoveryCodesLeft} recovery codes left.</p>
          <Field label="To turn it off, enter a code from your app"><input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" /></Field>
          <div><button className="btn" disabled={code.length < 6}>Turn off</button></div>
        </form>
      ) : setup ? (
        <form className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await api<{ recoveryCodes: string[] }>("/api/auth/mfa/enable", { body: { code } }); setCodes(r.recoveryCodes); setSetup(undefined); setCode(""); }); }}>
          <p style={{ margin: 0 }}>In your authenticator app (Google Authenticator, Microsoft Authenticator, 1Password), add an account with this key, or open the link on your phone.</p>
          <div className="code-box">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</div>
          <a href={setup.otpauthUrl} className="muted" style={{ fontSize: 13 }}>Open in authenticator app</a>
          <Field label="Then enter the 6-digit code it shows"><input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus /></Field>
          <div><button className="btn primary" disabled={code.length !== 6}>Turn on</button></div>
        </form>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <p className="muted" style={{ margin: 0 }}>Ask for a code from your phone as well as your password when you sign in. HMRC expects it for anyone who files VAT, and it protects the bank details Softilo holds.</p>
          <div><button className="btn primary" onClick={() => void run(async () => setSetup(await api("/api/auth/mfa/setup", { body: {} })))}>Set up two-factor sign-in</button></div>
        </div>
      )}
    </Card>
  );
}

function Password() {
  const [msg, setMsg] = useState<string>();
  const [error, setError] = useState<string>();
  return (
    <Card title="Password" pad>
      {msg && <div className="banner ok">{msg}</div>}
      <ErrorBanner message={error} />
      <form className="stack" style={{ gap: 12 }} onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const f = Object.fromEntries(new FormData(form));
        try { await api("/api/auth/password", { body: f }); form.reset(); setMsg("Password changed. You have been signed out everywhere else."); setError(undefined); }
        catch (err) { setError((err as Error).message); }
      }}>
        <Field label="Current password"><input name="current" type="password" autoComplete="current-password" required /></Field>
        <Field label="New password" hint="At least 12 characters"><input name="next" type="password" autoComplete="new-password" minLength={12} required /></Field>
        <div><button className="btn">Change password</button></div>
      </form>
    </Card>
  );
}

export default function TeamPage() {
  const { data, reload } = useApi<Team>("/api/team");
  const { data: me } = useApi<Me>("/api/auth/me");
  const [error, setError] = useState<string>();
  const [msg, setMsg] = useState<string>();
  const canManage = me && ["owner", "admin"].includes(me.role);

  return (
    <div className="stack">
      <PageHeader title="Team and security" subtitle="Who can use Softilo for this company, what each person can do, and how they sign in." />
      {msg && <div className="banner ok">{msg}</div>}
      <ErrorBanner message={error} />
      <Card title="Team">
        <DataTable rows={data?.members} columns={[
          { key: "n", label: "Name", render: (m) => <span>{m.name}<br /><small className="faint">{m.email}</small></span> },
          { key: "r", label: "Role", render: (m) => canManage && m.id !== me?.id ? (
            <select value={m.role} aria-label={`Role for ${m.name}`} onChange={async (e) => {
              try { await api(`/api/team/${m.id}`, { method: "PATCH", body: { role: e.target.value } }); setError(undefined); await reload(); } catch (err) { setError((err as Error).message); }
            }}>{data?.roles.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}</select>
          ) : <span style={{ textTransform: "capitalize" }}>{m.role}</span> },
          { key: "m", label: "Two-factor", render: (m) => (m.mfa_enabled ? <span className="pill quiet ok">On</span> : <span className="pill">Off</span>) },
          { key: "s", label: "Since", render: (m) => date(m.created_at) },
          { key: "x", label: "", num: true, render: (m) => canManage && m.id !== me?.id ? <button className="btn small ghost" onClick={async () => {
            if (!confirm(`Remove ${m.name}? They will lose access straight away.`)) return;
            try { await api(`/api/team/${m.id}`, { method: "DELETE" }); await reload(); } catch (err) { setError((err as Error).message); }
          }}>Remove</button> : null },
        ]} />
      </Card>
      <div className="grid-2">
        {canManage && (
          <Card title="Add someone" pad>
            <form className="stack" style={{ gap: 12 }} onSubmit={async (e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const f = Object.fromEntries(new FormData(form));
              try { await api("/api/team", { body: f }); form.reset(); setMsg(`Added ${f.name}. They have been emailed; give them the temporary password yourself.`); setError(undefined); await reload(); }
              catch (err) { setError((err as Error).message); }
            }}>
              <Field label="Name"><input name="name" required /></Field>
              <Field label="Email"><input name="email" type="email" required /></Field>
              <Field label="Role" hint={data?.roles.map((r) => `${r.id}: ${r.help}`).join(" ")}>
                <select name="role" defaultValue="viewer">{data?.roles.map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}</select>
              </Field>
              <Field label="Temporary password" hint="At least 12 characters. Tell them separately, not by email."><input name="temporaryPassword" type="text" minLength={12} required autoComplete="off" /></Field>
              <div><button className="btn primary">Add to team</button></div>
            </form>
          </Card>
        )}
        <div className="stack">
          <TwoFactor />
          <Password />
        </div>
      </div>
    </div>
  );
}
