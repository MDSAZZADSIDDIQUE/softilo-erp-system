"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ErrorBanner, Field } from "@/components/ui";
import { api } from "@/lib/api";
import { AuthSide } from "../auth-side";

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next") ?? "/";
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      await api("/api/auth/login", { body: { email: form.get("email"), password: form.get("password") } });
      router.push(next.startsWith("/") && !next.startsWith("//") ? next : "/");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div>
        <h1>Sign in</h1>
        <p className="muted" style={{ margin: "6px 0 0" }}>Softilo for construction and trades.</p>
      </div>
      <ErrorBanner message={error} />
      <Field label="Email"><input name="email" type="email" autoComplete="email" required autoFocus /></Field>
      <Field label="Password"><input name="password" type="password" autoComplete="current-password" required /></Field>
      <button className="btn primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      <p className="muted">New to Softilo? <Link href="/signup">Set up your company</Link></p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="auth">
      <AuthSide />
      <div className="auth-form"><Suspense><LoginForm /></Suspense></div>
    </div>
  );
}
