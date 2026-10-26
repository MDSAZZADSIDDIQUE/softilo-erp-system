"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api, useApi } from "@/lib/api";

export type NavGroup = { group: string; items: { href: string; label: string }[] };

const NAV: NavGroup[] = [
  { group: "Overview", items: [{ href: "/", label: "Dashboard" }] },
  { group: "Sales", items: [
    { href: "/invoices", label: "Invoices & credits" },
    { href: "/contacts?kind=customer", label: "Customers" },
  ] },
  { group: "Purchasing", items: [
    { href: "/purchase-orders", label: "Purchase orders" },
    { href: "/bills", label: "Supplier bills" },
    { href: "/shipments", label: "Shipments & landed cost" },
    { href: "/contacts?kind=supplier", label: "Suppliers" },
  ] },
  { group: "Inventory", items: [
    { href: "/products", label: "Products & stock" },
  ] },
  { group: "Banking", items: [
    { href: "/banking", label: "Bank reconciliation" },
    { href: "/payments", label: "Payments & receipts" },
  ] },
  { group: "Accounting", items: [
    { href: "/vat", label: "VAT" },
    { href: "/reports", label: "Reports" },
    { href: "/journals", label: "Journals" },
    { href: "/accounts", label: "Chart of accounts" },
  ] },
  { group: "Company", items: [
    { href: "/settings", label: "Settings" },
    { href: "/audit", label: "Audit trail" },
  ] },
];

function isActive(pathname: string, kind: string | null, href: string): boolean {
  const [base, query] = href.split("?") as [string, string | undefined];
  if (base === "/") return pathname === "/";
  if (query) return pathname.startsWith(base) && query === `kind=${kind}`;
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** `extraNav` lets a sector edition add its own menu groups; they appear before "Accounting". */
export function Shell({ children, extraNav = [] }: { children: React.ReactNode; extraNav?: NavGroup[] }) {
  const pathname = usePathname();
  const kind = useSearchParams().get("kind");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const at = NAV.findIndex((g) => g.group === "Accounting");
  const nav = extraNav.length ? [...NAV.slice(0, at), ...extraNav, ...NAV.slice(at)] : NAV;
  const { data: me } = useApi<{ name: string; email: string; role: string; tenant_name: string; vat_number: string | null }>("/api/auth/me");

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
            <small>{me.vat_number ? `VAT GB${me.vat_number}` : "Not VAT registered"}</small>
          </div>
        )}
        <nav aria-label="Main">
          {nav.map((g) => (
            <div className="nav-group" key={g.group}>
              <span>{g.group}</span>
              {g.items.map((i) => (
                <Link key={i.href} href={i.href} className={`nav-link${isActive(pathname, kind, i.href) ? " active" : ""}`}>
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
