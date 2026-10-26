export * from "../../../../apps/web/lib/format";

export const ENGAGEMENT_LABEL: Record<string, string> = { paye: "PAYE", umbrella: "Umbrella", ltd: "Limited company" };

export const ABSENCE_LABEL: Record<string, string> = {
  annual_leave: "Annual leave",
  sickness: "Sickness or injury",
  jury_service: "Jury service",
  hirer_shutdown: "Hirer shutdown",
  strike: "Strike or lock-out",
  pregnancy_maternity: "Pregnancy, childbirth or maternity",
  family_leave: "Maternity, paternity, adoption or shared parental leave",
  other: "Other break",
};

export function percent(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "–";
  return `${Number(value).toLocaleString("en-GB", { maximumFractionDigits: 2 })}%`;
}

/** The Sunday on or before `iso` (agency weeks end on Sunday by default). */
export function lastSunday(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
