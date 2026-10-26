import { Suspense } from "react";
import { Shell, type NavGroup } from "@/components/shell";

const MANUFACTURING: NavGroup[] = [
  { group: "Manufacturing", items: [
    { href: "/production", label: "Production overview" },
    { href: "/manufacturing/works-orders", label: "Works orders" },
    { href: "/manufacturing/boms", label: "Bills of materials" },
    { href: "/manufacturing/cost-rollup", label: "Cost roll-up" },
    { href: "/manufacturing/mrp", label: "Shortages (MRP)" },
    { href: "/manufacturing/work-centres", label: "Work centres" },
  ] },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense>
      <Shell extraNav={MANUFACTURING}>{children}</Shell>
    </Suspense>
  );
}
