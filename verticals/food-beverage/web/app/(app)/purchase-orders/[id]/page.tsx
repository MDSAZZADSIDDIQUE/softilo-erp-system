"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import CorePurchaseOrderPage from "@core/app/(app)/purchase-orders/[id]/page";
import { useApi } from "@core/lib/api";

/** The core purchase order screen, plus a route to batch-aware receiving when the order includes batch-tracked food. */
export default function PurchaseOrderPage() {
  const { id } = useParams<{ id: string }>();
  const { data: po } = useApi<{ status: string; lines: { product_id: string; quantity: string; received_qty: string }[] }>(`/api/purchase-orders/${id}`);
  const { data: food } = useApi<{ id: string; batch_tracked: boolean }[]>("/api/fnb/products");
  const tracked = new Set(food?.filter((p) => p.batch_tracked).map((p) => p.id));
  const needsBatches = po && ["approved", "part_received"].includes(po.status)
    && po.lines.some((l) => tracked.has(l.product_id) && Number(l.quantity) > Number(l.received_qty));

  return (
    <div className="stack">
      {needsBatches && (
        <div className="banner ok" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span>This order includes batch-tracked food. Receive it with batch codes and dates so it can be traced and sold first expiry, first out.</span>
          <Link className="btn primary" href={`/fnb/receive/${id}`}>Receive with batches</Link>
        </div>
      )}
      <CorePurchaseOrderPage />
    </div>
  );
}
