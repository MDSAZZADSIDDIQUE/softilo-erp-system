"use client";

const CIS: Record<string, { label: string; tone: string }> = {
  unverified: { label: "Not verified", tone: "signal" },
  gross: { label: "Gross · 0%", tone: "quiet ok" },
  net: { label: "Net · 20%", tone: "solid" },
  unmatched: { label: "Unmatched · 30%", tone: "signal" },
};

export function CisPill({ status }: { status: string | null }) {
  if (!status) return <span className="pill quiet">Not CIS</span>;
  const s = CIS[status] ?? { label: status, tone: "" };
  return <span className={`pill ${s.tone}`}>{s.label}</span>;
}

const STAGES: Record<string, string> = { interim: "Interim", practical_completion: "Practical completion", final: "Final account" };
export const stageLabel = (s: string) => STAGES[s] ?? s;

export const CATEGORY_LABELS: Record<string, string> = { labour: "Labour", materials: "Materials", plant: "Plant hire", other: "Other direct costs" };

export function percent(rate: string | number): string {
  return `${(Number(rate) * 100).toLocaleString("en-GB", { maximumFractionDigits: 2 })}%`;
}

export function Meter({ used }: { used: string | null }) {
  if (used === null) return <span className="faint">–</span>;
  const n = Number(used);
  return (
    <div style={{ display: "grid", gap: 4, minWidth: 90 }}>
      <div className={`meter${n > 100 ? " over" : ""}`}><i style={{ width: `${Math.min(n, 100)}%` }} /></div>
      <small className="muted">{used}%</small>
    </div>
  );
}

/** The CIS tax month (6th to 5th) a date falls in, named by its end date. */
export function taxMonthEndFor(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const end = d <= 5 ? new Date(Date.UTC(y, m - 1, 5)) : new Date(Date.UTC(y, m, 5));
  return end.toISOString().slice(0, 10);
}

export function shiftTaxMonth(end: string, by: number): string {
  const [y, m] = end.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + by, 5)).toISOString().slice(0, 10);
}
