import { d, type DecInput } from "@softilo/domain";

/**
 * How a temporary worker is engaged, and what that means for the agency.
 *   paye     – the agency is the employer: it runs PAYE/NI, pension auto-enrolment and holiday pay.
 *   umbrella – an umbrella company employs the worker and invoices the agency. Since 6 April 2026 the agency
 *              is jointly and severally liable for PAYE the umbrella fails to pay, so due diligence matters.
 *   ltd      – the worker's own limited company (personal service company) invoices the agency. The off-payroll
 *              rules (IR35) decide whether the engagement is a deemed employment.
 */
export type Engagement = "paye" | "umbrella" | "ltd";

/** Off-payroll status of a limited-company engagement. */
export type Ir35Status = "inside" | "outside";

/** Off-payroll working: who makes the status determination depends on the end client's size. */
export type ClientSize = "small" | "medium_large";

export interface EngagementDefaults {
  /** Whether the Agency Workers Regulations normally apply (genuinely self-employed contractors are outside them). */
  awrApplies: boolean;
  /** Rolled-up holiday pay rate for irregular-hours workers; 0 where the pay rate already includes it. */
  holidayRate: string;
  /** Whether a Key Information Document must be given before terms are agreed (Conduct Regulations, from April 2020). */
  kidRequired: boolean;
}

/** 12.07% = 5.6 weeks ÷ (52 − 5.6) weeks: the rolled-up rate allowed for irregular-hours and part-year workers since April 2024. */
export const ROLLED_UP_HOLIDAY_RATE = "0.1207";

export function engagementDefaults(engagement: Engagement): EngagementDefaults {
  switch (engagement) {
    case "paye": return { awrApplies: true, holidayRate: ROLLED_UP_HOLIDAY_RATE, kidRequired: true };
    // The umbrella employer pays holiday; the agency's cost is the umbrella's invoice.
    case "umbrella": return { awrApplies: true, holidayRate: "0", kidRequired: true };
    case "ltd": return { awrApplies: false, holidayRate: "0", kidRequired: false };
  }
}

export interface PlacementCheckInput {
  engagement: Engagement;
  ir35Status?: Ir35Status | null;
  clientSize: ClientSize;
  /** Date the end client's Status Determination Statement was received. */
  sdsReceivedOn?: string | null;
  kidIssuedOn?: string | null;
  startDate: string;
  rates: { rateType: string; payRate: DecInput; chargeRate: DecInput }[];
}

export interface PlacementCheck {
  errors: string[];
  warnings: string[];
}

/**
 * Compliance checks before a placement can start. Errors block it; warnings are shown to the consultant.
 */
export function checkPlacement(p: PlacementCheckInput): PlacementCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (p.rates.length === 0) errors.push("A placement needs at least one pay and charge rate");
  const seen = new Set<string>();
  for (const r of p.rates) {
    if (seen.has(r.rateType)) errors.push(`Rate type "${r.rateType}" is listed twice`);
    seen.add(r.rateType);
    if (d(r.payRate).isNegative() || d(r.chargeRate).isNegative()) errors.push(`Rates for "${r.rateType}" cannot be negative`);
    if (d(r.chargeRate).lessThan(r.payRate)) warnings.push(`The charge rate for "${r.rateType}" is below the pay rate`);
  }
  if (p.engagement === "ltd") {
    if (!p.ir35Status) errors.push("Record the IR35 status for a limited-company contractor");
    if (p.clientSize === "medium_large" && !p.sdsReceivedOn) {
      errors.push("A medium or large client must give a Status Determination Statement before the placement starts");
    }
    if (p.ir35Status === "inside") {
      warnings.push("Inside IR35: as fee-payer the agency must deduct PAYE and NI from the deemed payment (fee-payer payroll is not built yet)");
    }
  }
  if (p.engagement === "paye") {
    const nlw = nationalLivingWage(p.startDate);
    for (const r of p.rates) {
      if (nlw && d(r.payRate).lessThan(nlw)) {
        warnings.push(`The "${r.rateType}" pay rate is below the National Living Wage (£${nlw}/hour for workers aged 21 and over)`);
      }
    }
  }
  if (p.engagement !== "ltd") {
    if (!p.kidIssuedOn) errors.push("Give the worker a Key Information Document before agreeing terms");
    else if (p.kidIssuedOn > p.startDate) errors.push("The Key Information Document must be issued before the placement starts");
  }
  return { errors, warnings };
}

/**
 * National Living Wage (age 21+) by date it took effect. Check PAYE pay rates against it.
 * The April 2026 rate was announced in the November 2025 Budget; verify against GOV.UK before relying on it.
 */
export const NATIONAL_LIVING_WAGE: { from: string; hourly: string }[] = [
  { from: "2024-04-01", hourly: "11.44" },
  { from: "2025-04-01", hourly: "12.21" },
  { from: "2026-04-01", hourly: "12.71" },
];

export function nationalLivingWage(on: string): string | undefined {
  let rate: string | undefined;
  for (const r of NATIONAL_LIVING_WAGE) if (r.from <= on) rate = r.hourly;
  return rate;
}
