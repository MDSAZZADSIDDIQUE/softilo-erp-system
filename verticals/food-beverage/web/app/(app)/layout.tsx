"use client";

import { Suspense } from "react";
import { Shell } from "@core/components/shell";
import { FNB_NAV } from "@/components/nav";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense>
      <Shell nav={FNB_NAV}>{children}</Shell>
    </Suspense>
  );
}
