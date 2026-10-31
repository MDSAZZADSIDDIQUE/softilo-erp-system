"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main className="state-page">
      <div>
        <img src="/brand/symbol.svg" alt="" />
        <h1>Something went wrong</h1>
        <p>This page hit a problem. Nothing you already saved has been lost.</p>
        <div className="actions">
          <button className="btn primary" onClick={reset}>Try again</button>
          <Link className="btn" href="/">Go to the dashboard</Link>
        </div>
      </div>
    </main>
  );
}
