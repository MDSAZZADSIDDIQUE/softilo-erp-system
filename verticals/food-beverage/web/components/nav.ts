import { NAV, type NavGroup } from "@core/components/shell";

/** The core menu with a Food safety section after Inventory. */
export const FNB_NAV: NavGroup[] = NAV.flatMap((g) => g.group !== "Inventory" ? [g] : [g, {
  group: "Food safety",
  items: [
    { href: "/fnb/batches", label: "Batches" },
    { href: "/fnb/expiry", label: "Expiry report" },
    { href: "/fnb/recall", label: "Recall trace" },
    { href: "/fnb/products", label: "Food settings" },
  ],
}]);
