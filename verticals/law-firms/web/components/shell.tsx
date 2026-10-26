"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { api, useApi } from "@/lib/api";

const NAV: { group: string; items: { href: string; label: string }[] }[] = [
  { group: "Overview", items: [{ href: "/", label: "Dashboard" }] },
  { group: "Practice", items: [
    { href: "/matters", label: "Matters" },
    { href: "/clients", label: "Clients" },
    { href: "/fee-earners", label: "Fee earners" },
  ] },
  { group: "Client money", items: [
    { href: "/reconciliation", label: "Three-way reconciliation" },
  ] },
  { group: "Accounting", items: [
    { href: "/vat", label: "VAT" },
    { href: "/reports", label: "Reports" },
    { href: "/journals", label: "Journals" },
    { href: "/accounts", label: "Chart of accounts" },
  ] },
  { group: "Firm", items: [
    { href: "/settings", label: "Settings" },
    { href: "/audit", label: "Audit trail" },
  ] },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { data: me } = useApi<{ name: string; role: string; tenant_name: string; vat_number: string | null }>("/api/auth/me");

  async function signOut() {
    await api("/api/auth/logout", { method: "POST", body: {} });
    router.push("/login");
  }

  return (
    <div className="shell">
      <div className="mobile-bar">
        <img src="/brand/logo-reversed.svg" alt="Softilo" />
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="sidebar">Menu</button>
      </div>
      <aside id="sidebar" className={`sidebar${open ? " open" : ""}`} onClick={(e) => { if ((e.target as HTMLElement).closest("a")) setOpen(false); }}>
        <Link href="/" className="brand" aria-label="Softilo home">
          <img src="/brand/logo-reversed.svg" alt="Softilo" />
        </Link>
        {me && (
          <div className="company">
            {me.tenant_name}
            <small>Law Firms edition</small>
          </div>
        )}
        <nav aria-label="Main">
          {NAV.map((g) => (
            <div className="nav-group" key={g.group}>
              <span>{g.group}</span>
              {g.items.map((i) => (
                <Link key={i.href} href={i.href} className={`nav-link${isActive(pathname, i.href) ? " active" : ""}`}>
                  {i.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="spacer" />
        {me && (
          <div className="user">
            <div>{me.name}</div>
            <div style={{ color: "var(--sidebar-muted)", fontSize: 12, marginBottom: 6, textTransform: "capitalize" }}>{me.role}</div>
            <button onClick={signOut}>Sign out</button>
          </div>
        )}
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}

export function AuthSide() {
  return (
    <aside className="auth-side">
      <img src="/brand/logo-tagline-reversed.svg" alt="Softilo — Innovation, Leadership, Outcomes" />
      <div>
        <h2>Client money, matters and billing in one ledger, built for law firms.</h2>
        <ul>
          <li>Client and office ledgers on every matter</li>
          <li>No client ledger can ever be overdrawn</li>
          <li>Three-way reconciliation with COFA sign-off</li>
          <li>Hosted in the UK. Your data never leaves it.</li>
        </ul>
      </div>
      <small style={{ color: "#8f8a7f" }}>© {new Date().getFullYear()} Softilo</small>
    </aside>
  );
}
