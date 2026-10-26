"use client";

import { useApi } from "@/lib/api";

const BATCH: Record<string, { label: string; tone: string }> = {
  quarantine: { label: "Quarantine", tone: "signal" },
  released: { label: "Released", tone: "quiet ok" },
  rejected: { label: "Rejected", tone: "solid" },
  recalled: { label: "Recalled", tone: "solid" },
};

export function BatchStatus({ value }: { value: string }) {
  const s = BATCH[value] ?? { label: value, tone: "" };
  return <span className={`pill ${s.tone}`}>{s.label}</span>;
}

const BANDS: Record<string, { label: string; tone: string }> = {
  expired: { label: "Expired", tone: "solid" },
  "30": { label: "≤ 30 days", tone: "signal" },
  "90": { label: "≤ 90 days", tone: "signal" },
  "180": { label: "≤ 180 days", tone: "" },
};

export function ExpiryBand({ band }: { band: string }) {
  const b = BANDS[band];
  return b ? <span className={`pill ${b.tone}`}>{b.label}</span> : null;
}

export const LICENCE_LABELS: Record<string, string> = {
  wda_h: "Wholesale dealer's authorisation (WDA(H))",
  gphc_pharmacy: "Registered pharmacy premises (GPhC)",
  gmc_practitioner: "Registered medical practitioner (GMC)",
  dispensing_doctor: "Dispensing doctor practice",
  nhs_trust: "NHS trust or hospital",
  home_office_cd: "Home Office controlled drugs licence",
};

export function useIsRp(): boolean | undefined {
  return useApi<{ isResponsiblePerson: boolean }>("/api/pharma/me").data?.isResponsiblePerson;
}
