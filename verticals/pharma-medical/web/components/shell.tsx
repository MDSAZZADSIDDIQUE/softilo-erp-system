"use client";

import { NAV, Shell as CoreShell, type NavGroup } from "@core/components/shell";

/** Core navigation with the Good Distribution Practice screens added after Overview. */
const PHARMA_NAV: NavGroup[] = [
  NAV[0]!,
  { group: "Quality (GDP)", items: [
    { href: "/quality", label: "GDP overview" },
    { href: "/batches", label: "Batches & release" },
    { href: "/goods-in", label: "Goods in (batches)" },
    { href: "/dispatch", label: "Dispatch (FEFO)" },
    { href: "/recalls", label: "Recalls & trace" },
    { href: "/licences", label: "Customer licences" },
    { href: "/classification", label: "Product classification" },
    { href: "/responsible-persons", label: "Responsible Persons" },
  ] },
  ...NAV.slice(1),
];

export function Shell({ children }: { children: React.ReactNode }) {
  return <CoreShell nav={PHARMA_NAV}>{children}</CoreShell>;
}
