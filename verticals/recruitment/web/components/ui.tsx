"use client";

import type { ReactNode } from "react";
import { Status as CoreStatus } from "../../../../apps/web/components/ui";

export * from "../../../../apps/web/components/ui";

const REC_STATUS: Record<string, { label: string; tone: string }> = {
  active: { label: "Active", tone: "solid" },
  ended: { label: "Ended", tone: "quiet" },
  rejected: { label: "Rejected", tone: "signal" },
  invoiced: { label: "Invoiced", tone: "quiet ok" },
  qualified: { label: "Qualified", tone: "quiet ok" },
  accruing: { label: "Accruing", tone: "" },
  paused: { label: "Paused", tone: "signal" },
  reset: { label: "Reset", tone: "signal" },
  not_started: { label: "Not started", tone: "quiet" },
};

/** Core statuses plus the recruitment ones (submitted = waiting for the client to approve). */
export function RecStatus({ value }: { value: string }): ReactNode {
  if (value === "submitted") return <span className="pill signal">Awaiting approval</span>;
  const s = REC_STATUS[value];
  return s ? <span className={`pill ${s.tone}`}>{s.label}</span> : <CoreStatus value={value} />;
}
