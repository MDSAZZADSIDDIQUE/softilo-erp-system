"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorBanner, Field } from "@/components/ui";
import { api } from "@/lib/api";
import { AuthSide } from "@law/components/shell";

export default function SignupPage() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError(undefined);
    try {
      await api("/api/auth/signup", { body: f });
      await api("/api/law/setup", { body: {} });
      router.push("/");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <AuthSide />
      <div className="auth-form">
        <form onSubmit={submit}>
          <div>
            <h1>Set up your firm</h1>
            <p className="muted" style={{ margin: "6px 0 0" }}>We&apos;ll create a UK chart of accounts with a separate client bank account.</p>
          </div>
          <ErrorBanner message={error} />
          <Field label="Firm name"><input name="companyName" required autoFocus /></Field>
          <div className="grid-2" style={{ gap: 12 }}>
            <Field label="Company or LLP number" hint="Companies House, optional"><input name="companyNumber" maxLength={8} /></Field>
            <Field label="VAT number" hint="Optional"><input name="vatNumber" placeholder="GB123456789" /></Field>
          </div>
          <Field label="Your name"><input name="name" autoComplete="name" required /></Field>
          <Field label="Work email"><input name="email" type="email" autoComplete="email" required /></Field>
          <Field label="Password" hint="At least 12 characters"><input name="password" type="password" autoComplete="new-password" minLength={12} required /></Field>
          <button className="btn primary" disabled={busy}>{busy ? "Creating…" : "Create firm"}</button>
          <p className="muted">Already set up? <Link href="/login">Sign in</Link></p>
        </form>
      </div>
    </div>
  );
}
