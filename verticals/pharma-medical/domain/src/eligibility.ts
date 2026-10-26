/**
 * Customer qualification ("bona fides"). A wholesaler may only supply medicines to a customer who is
 * entitled to receive them, and must verify that entitlement. These rules are the product defaults;
 * docs/plan.md §3.7–3.8 lists the points still to be confirmed with a Responsible Person.
 */

import { addDays } from "./expiry.js";

export const LICENCE_TYPES = {
  wda_h: "Wholesale dealer's authorisation (WDA(H))",
  gphc_pharmacy: "Registered pharmacy premises (GPhC)",
  gmc_practitioner: "Registered medical practitioner (GMC)",
  dispensing_doctor: "Dispensing doctor practice",
  nhs_trust: "NHS trust or hospital",
  home_office_cd: "Home Office controlled drugs licence",
} as const;
export type LicenceType = keyof typeof LICENCE_TYPES;

/** Entitled to receive prescription-only (POM) and pharmacy (P) medicines. */
const MEDICINE_ENTITLED: LicenceType[] = ["wda_h", "gphc_pharmacy", "gmc_practitioner", "dispensing_doctor", "nhs_trust"];
/** May receive Schedule 2 and 3 controlled drugs: professions authorised by the 2001 Regulations, or a Home Office licence. [verify] */
const CD_ENTITLED: LicenceType[] = ["home_office_cd", "gphc_pharmacy", "gmc_practitioner", "dispensing_doctor", "nhs_trust"];

export type LegalCategory = "POM" | "P" | "GSL";

export interface ProductClass {
  kind: "medicine" | "device";
  legalCategory?: LegalCategory | null;
  cdSchedule?: number | null;
}

export interface CustomerLicence {
  id?: string;
  type: LicenceType;
  number: string;
  validFrom?: string | null;
  expiresOn?: string | null;
  verifiedOn?: string | null;
  status: "active" | "suspended";
}

export interface EligibilityOptions {
  onDate: string;
  /** Re-check registrations at least this often. Default: yearly. */
  reverifyDays?: number;
}

export type Eligibility =
  | { ok: true; requiresLicence: boolean; licences: CustomerLicence[] }
  | { ok: false; reason: string };

/** Why a licence can't be relied on, or null when it is good on the date. */
export function licenceProblem(l: CustomerLicence, opts: EligibilityOptions): string | null {
  const label = `${LICENCE_TYPES[l.type]} ${l.number}`;
  if (l.status !== "active") return `${label} is suspended`;
  if (l.validFrom && l.validFrom > opts.onDate) return `${label} is not valid until ${l.validFrom}`;
  if (l.expiresOn && l.expiresOn < opts.onDate) return `${label} expired on ${l.expiresOn}`;
  if (!l.verifiedOn) return `${label} has not been verified`;
  if (l.verifiedOn > opts.onDate) return `${label} is verified with a future date`;
  if (addDays(l.verifiedOn, opts.reverifyDays ?? 365) < opts.onDate) {
    return `${label} was last verified on ${l.verifiedOn} and needs re-checking`;
  }
  return null;
}

function pick(licences: CustomerLicence[], types: LicenceType[], opts: EligibilityOptions) {
  const relevant = licences.filter((l) => types.includes(l.type));
  return {
    good: relevant.filter((l) => !licenceProblem(l, opts)),
    problems: relevant.map((l) => licenceProblem(l, opts)).filter((p): p is string => Boolean(p)),
  };
}

export function checkSupplyEligibility(product: ProductClass, licences: CustomerLicence[], opts: EligibilityOptions): Eligibility {
  if (product.kind === "device") return { ok: true, requiresLicence: false, licences: [] };
  const schedule = product.cdSchedule ?? null;
  if (schedule === 1) return { ok: false, reason: "Schedule 1 controlled drugs cannot be supplied from Softilo" };
  const category = product.legalCategory ?? "POM";
  if (category === "GSL" && !schedule) return { ok: true, requiresLicence: false, licences: [] };

  const med = pick(licences, MEDICINE_ENTITLED, opts);
  if (!med.good.length) {
    return {
      ok: false,
      reason: med.problems.length
        ? `The customer is not entitled to receive ${category} medicines: ${med.problems.join("; ")}`
        : `The customer has no licence or registration on file that entitles them to receive ${category} medicines`,
    };
  }
  if (schedule === 2 || schedule === 3) {
    const cd = pick(licences, CD_ENTITLED, opts);
    if (!cd.good.length) {
      return { ok: false, reason: `Schedule ${schedule} controlled drugs need a valid Home Office licence or professional authorisation on file` };
    }
    return { ok: true, requiresLicence: true, licences: [...new Set([...med.good, ...cd.good])] };
  }
  return { ok: true, requiresLicence: true, licences: med.good };
}
