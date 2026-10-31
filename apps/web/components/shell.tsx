"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { api, useApi } from "@/lib/api";
import { AccountsIcon, AuditIcon, BankIcon, BanknoteIcon, BoxIcon, ClipboardIcon, CustomersIcon, DashboardIcon, InvoiceIcon, JournalIcon, MenuIcon, PercentIcon, ReceiptIcon, ReportsIcon, SettingsIcon, ShipIcon, SignOutIcon, WarehouseIcon, type SoftiloIcon } from "@/components/softilo-icons";

const NAV: { group: string; items: { href: string; label: string; icon: SoftiloIcon }[] }[] = [
  { group: "Overview", items: [{ href: "/", label: "Dashboard", icon: DashboardIcon }] },
  { group: "Sales", items: [
    { href: "/invoices", label: "Invoices & credits", icon: InvoiceIcon },
    { href: "/contacts?kind=customer", label: "Customers", icon: CustomersIcon },
  ] },
  { group: "Purchasing", items: [
    { href: "/purchase-orders", label: "Purchase orders", icon: ClipboardIcon },
    { href: "/bills", label: "Supplier bills", icon: ReceiptIcon },
    { href: "/shipments", label: "Shipments & landed cost", icon: ShipIcon },
    { href: "/contacts?kind=supplier", label: "Suppliers", icon: WarehouseIcon },
  ] },
  { group: "Inventory", items: [
    { href: "/products", label: "Products & stock", icon: BoxIcon },
  ] },
  { group: "Banking", items: [
    { href: "/banking", label: "Bank reconciliation", icon: BankIcon },
    { href: "/payments", label: "Payments & receipts", icon: BanknoteIcon },
  ] },
  { group: "Accounting", items: [
    { href: "/vat", label: "VAT", icon: PercentIcon },
    { href: "/reports", label: "Reports", icon: ReportsIcon },
    { href: "/journals", label: "Journals", icon: JournalIcon },
    { href: "/accounts", label: "Chart of accounts", icon: AccountsIcon },
  ] },
  { group: "Company", items: [
    { href: "/settings", label: "Settings", icon: SettingsIcon },
    { href: "/audit", label: "Audit trail", icon: AuditIcon },
  ] },
];

function isActive(pathname: string, kind: string | null, href: string): boolean {
  const [base, query] = href.split("?") as [string, string | undefined];
  if (base === "/") return pathname === "/";
  if (query) return pathname.startsWith(base) && query === `kind=${kind}`;
  return pathname === base || pathname.startsWith(`${base}/`);
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const kind = useSearchParams().get("kind");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { data: me } = useApi<{ name: string; email: string; role: string; tenant_name: string; vat_number: string | null }>("/api/auth/me");

  async function signOut() {
    await api("/api/auth/logout", { method: "POST", body: {} });
    router.push("/login");
  }

  return (
    <div className="shell">
      <div className="mobile-bar">
        <img src="/brand/logo-reversed.svg" alt="Softilo" />
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="sidebar"><MenuIcon size={18} />Menu</button>
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
          {NAV.map((g) => (
            <div className="nav-group" key={g.group}>
              <span>{g.group}</span>
              {g.items.map((i) => {
                const active = isActive(pathname, kind, i.href);
                return (
                  <Link key={i.href} href={i.href} className={`nav-link${active ? " active" : ""}`}>
                    {/* The current page's icon is filled. */}
                    <i.icon tint={active ? "var(--nav-active-icon)" : "currentColor"} tintOpacity={active ? 0.9 : undefined} />
                    {i.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="spacer" />
        {me && (
          <div className="user">
            <div>{me.name}</div>
            <div style={{ color: "var(--sidebar-muted)", fontSize: 12, marginBottom: 6, textTransform: "capitalize" }}>{me.role}</div>
            <button onClick={signOut}><SignOutIcon size={16} />Sign out</button>
          </div>
        )}
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}
