"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, useApi } from "@/lib/api";

interface Demo { available: boolean; email?: string; password?: string; company?: string }

/** Shown on the login page when a sample company exists and the server allows it. */
export function DemoAccess() {
  const router = useRouter();
  const { data } = useApi<Demo>("/api/auth/demo");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!data?.available) return null;

  async function open() {
    setBusy(true);
    setError(undefined);
    try {
      await api("/api/auth/login", { body: { email: data!.email, password: data!.password } });
      router.push("/");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="demo-access">
      <strong>Explore the demo</strong>
      <p>See {data.company} at work: months of sample trading in every screen, no sign-up needed.</p>
      {error && <p role="alert" style={{ color: "var(--accent-text)" }}>{error}</p>}
      <button type="button" className="btn" disabled={busy} onClick={open}>{busy ? "Opening…" : "Open the demo"}</button>
    </div>
  );
}
