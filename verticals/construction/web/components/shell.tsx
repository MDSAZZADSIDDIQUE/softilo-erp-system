"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { api, useApi } from "@/lib/api";

const NAV: { group: string; items: { href: string; label: string }[] }[] = [
  { group: "Overview", items: [{ href: "/", label: "Dashboard" }] },
  { group: "Jobs", items: [
    { href: "/projects", label: "Projects & job costing" },
    { href: "/applications", label: "Applications for payment" },
  ] },
  { group: "Subcontractors", items: [
    { href: "/subcontractors", label: "Subcontractors" },
    { href: "/bills", label: "Job bills" },
    { href: "/cis", label: "CIS returns" },
  ] },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
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
        <span className="edition">Construction & trades</span>
        {me && (
          <div className="company">
            {me.tenant_name}
            <small>{me.vat_number ? `VAT GB${me.vat_number}` : "Not VAT registered"}</small>
          </div>
        )}
        <nav aria-label="Main">
          {NAV.map((g) => (
            <div className="nav-group" key={g.group}>
              <span>{g.group}</span>
              {g.items.map((i) => (
                <Link key={i.href} href={i.href} className={`nav-link${isActive(pathname, i.href) ? " active" : ""}`}>{i.label}</Link>
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
