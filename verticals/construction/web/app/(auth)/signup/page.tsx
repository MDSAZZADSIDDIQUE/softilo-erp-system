"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorBanner, Field } from "@/components/ui";
import { api } from "@/lib/api";
import { AuthSide } from "../auth-side";

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
          <div><h1>Set up your company</h1></div>
          <ErrorBanner message={error} />
          <Field label="Company name"><input name="companyName" required /></Field>
          <Field label="Companies House number" hint="Optional"><input name="companyNumber" /></Field>
          <Field label="VAT number" hint="Optional, e.g. GB123456789"><input name="vatNumber" /></Field>
          <Field label="Your name"><input name="name" required autoComplete="name" /></Field>
          <Field label="Email"><input name="email" type="email" required autoComplete="email" /></Field>
          <Field label="Password" hint="At least 12 characters"><input name="password" type="password" required minLength={12} autoComplete="new-password" /></Field>
          <button className="btn primary" disabled={busy}>{busy ? "Setting up…" : "Create account"}</button>
          <p className="muted">Already using Softilo? <Link href="/login">Sign in</Link></p>
        </form>
      </div>
    </div>
  );
}
