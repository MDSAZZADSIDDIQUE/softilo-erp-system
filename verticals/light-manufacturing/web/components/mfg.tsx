"use client";

import type { ReactNode } from "react";
import { money } from "@/lib/format";

const STATUS: Record<string, { label: string; tone: string }> = {
  planned: { label: "Planned", tone: "" },
  released: { label: "Released", tone: "signal" },
  completed: { label: "Completed", tone: "quiet ok" },
  cancelled: { label: "Cancelled", tone: "quiet" },
  make: { label: "Make", tone: "solid" },
  buy: { label: "Buy", tone: "signal" },
};

export function MfgStatus({ value }: { value: string | null }) {
  if (!value) return <span className="pill quiet ok">Covered</span>;
  const s = STATUS[value] ?? { label: value, tone: "" };
  return <span className={`pill ${s.tone}`}>{s.label}</span>;
}

/** Unit costs carry 6 decimal places; show pence with sub-penny detail when it matters. */
export function unitCost(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "–";
  const n = Number(value);
  return Math.abs(n) < 1 && n !== 0 ? `£${n.toFixed(4)}` : money(n);
}

/** Material / labour / overhead split of a unit cost. */
export function CostBar({ material, labour, overhead }: { material: string; labour: string; overhead: string }) {
  const parts = [Number(material), Number(labour), Number(overhead)];
  const total = parts.reduce((a, b) => a + b, 0) || 1;
  return (
    <div className="cost-bar" role="img" aria-label={`Material ${unitCost(material)}, labour ${unitCost(labour)}, overhead ${unitCost(overhead)}`}>
      {["material", "labour", "overhead"].map((k, i) => <span key={k} className={k} style={{ width: `${(parts[i]! / total) * 100}%` }} />)}
    </div>
  );
}

export function CostLegend(): ReactNode {
  return (
    <div className="legend">
      <span><i className="material" />Material</span>
      <span><i className="labour" />Labour</span>
      <span><i className="overhead" />Overhead</span>
    </div>
  );
}
