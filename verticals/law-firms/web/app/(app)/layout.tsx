import { Suspense } from "react";
import { Shell } from "@law/components/shell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense>
      <Shell>{children}</Shell>
    </Suspense>
  );
}
