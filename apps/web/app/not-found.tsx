import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main className="state-page">
      <div>
        <img src="/brand/symbol.svg" alt="" />
        <h1>Page not found</h1>
        <p>That page doesn&apos;t exist, or the link has changed.</p>
        <div className="actions"><Link className="btn primary" href="/">Go to the dashboard</Link></div>
      </div>
    </main>
  );
}
