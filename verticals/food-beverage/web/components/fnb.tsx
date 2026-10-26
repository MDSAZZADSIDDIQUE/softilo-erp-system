"use client";

import { date } from "@core/lib/format";

export type BatchStatus = "expired" | "past_best_before" | "expiring" | "ok" | "no_date";

export const ALLERGENS: { id: string; label: string }[] = [
  { id: "gluten", label: "Cereals with gluten" },
  { id: "crustaceans", label: "Crustaceans" },
  { id: "eggs", label: "Eggs" },
  { id: "fish", label: "Fish" },
  { id: "peanuts", label: "Peanuts" },
  { id: "soybeans", label: "Soya" },
  { id: "milk", label: "Milk" },
  { id: "nuts", label: "Tree nuts" },
  { id: "celery", label: "Celery" },
  { id: "mustard", label: "Mustard" },
  { id: "sesame", label: "Sesame" },
  { id: "sulphites", label: "Sulphites" },
  { id: "lupin", label: "Lupin" },
  { id: "molluscs", label: "Molluscs" },
];

const STATUS: Record<BatchStatus, { label: string; tone: string }> = {
  expired: { label: "Past use-by", tone: "signal" },
  past_best_before: { label: "Past best-before", tone: "signal" },
  expiring: { label: "Expiring soon", tone: "" },
  ok: { label: "In date", tone: "quiet ok" },
  no_date: { label: "No date", tone: "quiet" },
};

export function ExpiryPill({ status }: { status: BatchStatus }) {
  const s = STATUS[status];
  return <span className={`pill ${s.tone}`}>{s.label}</span>;
}

export function dateTypeLabel(t: string | null | undefined): string {
  return t === "best_before" ? "Best before" : "Use by";
}

/** "Use by 28 Oct 2026" */
export function DateMark({ expiry, type }: { expiry: string | null; type: string }) {
  if (!expiry) return <span className="faint">No date</span>;
  return <span><span className="muted">{type === "best_before" ? "BB" : "UB"}</span> {date(expiry)}</span>;
}

export function DaysLeft({ days }: { days: number | null }) {
  if (days === null) return <span className="faint">–</span>;
  const text = days < 0 ? `${-days} ${days === -1 ? "day" : "days"} ago` : days === 0 ? "Today" : `${days} ${days === 1 ? "day" : "days"}`;
  return <span className={`days-left${days <= 3 ? " urgent" : ""}`}>{text}</span>;
}

/** Days from today to a YYYY-MM-DD date, in the browser's calendar. */
export function daysFromToday(d: string | null): number | null {
  if (!d) return null;
  const now = new Date();
  const t = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const e = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((e - t) / 86_400_000);
}
