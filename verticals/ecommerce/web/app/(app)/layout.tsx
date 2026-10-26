import { Suspense } from "react";
import { Shell, type NavGroup } from "@/components/shell";

const ECOMMERCE_NAV: NavGroup[] = [
  { group: "E-commerce", items: [
    { href: "/ecommerce", label: "Channels" },
    { href: "/ecommerce/orders", label: "Channel orders" },
    { href: "/ecommerce/payouts", label: "Payouts" },
    { href: "/ecommerce/returns", label: "Returns" },
  ] },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense>
      <Shell extraNav={ECOMMERCE_NAV}>{children}</Shell>
    </Suspense>
  );
}
