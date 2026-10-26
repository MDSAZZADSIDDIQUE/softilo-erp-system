import type { AccountTemplate } from "@softilo/domain";
import type { CostCategory } from "./cis.js";

/**
 * Accounts the construction edition adds to the core UK chart. Roles are prefixed `cons_` so
 * they can never clash with core roles.
 */
export type ConstructionRole = "cons_retentions" | "cons_cis_suffered" | "cons_cis_liability";

export interface ConstructionAccount extends Omit<AccountTemplate, "role"> {
  role?: ConstructionRole;
}

export const CONSTRUCTION_ACCOUNTS: ConstructionAccount[] = [
  // Only applications for payment post here; manual journals are refused.
  { code: "1105", name: "Retentions receivable", type: "asset", role: "cons_retentions", control: true },
  // Deducted from us by contractors when we work as a subcontractor; offset against PAYE.
  { code: "1106", name: "CIS deductions suffered", type: "asset", role: "cons_cis_suffered" },
  // Deducted from our subcontractors; paid to HMRC with the monthly CIS300.
  { code: "2211", name: "CIS deductions payable", type: "liability", role: "cons_cis_liability" },
  { code: "5300", name: "Subcontract labour", type: "expense" },
  { code: "5310", name: "Job materials", type: "expense" },
  { code: "5320", name: "Plant hire", type: "expense" },
  { code: "5330", name: "Other direct job costs", type: "expense" },
];

export const CATEGORY_ACCOUNTS: Record<CostCategory, string> = {
  labour: "5300",
  materials: "5310",
  plant: "5320",
  other: "5330",
};
