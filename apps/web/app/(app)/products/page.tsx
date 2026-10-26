"use client";

import Link from "next/link";
import { useState } from "react";
import { Card, DataTable, Empty, ErrorBanner, PageHeader } from "@/components/ui";
import { useApi } from "@/lib/api";
import { money, qty } from "@/lib/format";

interface Product {
  id: string; sku: string; name: string; uom: string; hs_code: string | null; sales_price: string; track_stock: boolean;
  on_hand: string; stock_value: string; average_cost: string; reorder_level: string | null;
}

export default function ProductsPage() {
  const [search, setSearch] = useState("");
  const { data, error } = useApi<Product[]>(`/api/products${search ? `?search=${encodeURIComponent(search)}` : ""}`);
  const total = data?.reduce((s, p) => s + Math.round(Number(p.stock_value) * 100), 0) ?? 0;

  return (
    <div className="stack">
      <PageHeader title="Products & stock" subtitle={data ? `${data.length} products · ${money(total / 100)} in stock at landed cost` : undefined}>
        <Link className="btn primary" href="/products/new">New product</Link>
      </PageHeader>
      <ErrorBanner message={error} />
      <Card title={<input type="search" placeholder="Search SKU or name…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 320 }} />}>
        <DataTable rows={data} href={(p) => `/products/${p.id}`}
          empty={<Empty title="No products yet"><Link href="/products/new">Add your first product</Link></Empty>}
          columns={[
            { key: "sku", label: "SKU", render: (p) => <Link href={`/products/${p.id}`}>{p.sku}</Link> },
            { key: "name", label: "Name", render: (p) => p.name },
            { key: "hs", label: "Commodity code", render: (p) => p.hs_code ?? <span className="faint">–</span> },
            { key: "price", label: "Sale price", num: true, render: (p) => money(p.sales_price) },
            { key: "on", label: "On hand", num: true, render: (p) => {
              const low = p.reorder_level !== null && Number(p.on_hand) <= Number(p.reorder_level);
              return <span style={low ? { color: "var(--accent-text)", fontWeight: 500 } : undefined}>{p.track_stock ? qty(p.on_hand) : "–"}</span>;
            } },
            { key: "avg", label: "Avg landed cost", num: true, render: (p) => p.track_stock ? `£${Number(p.average_cost).toFixed(4)}` : "–" },
            { key: "val", label: "Stock value", num: true, render: (p) => money(p.stock_value) },
          ]} />
      </Card>
    </div>
  );
}
