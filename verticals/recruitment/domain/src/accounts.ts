import type { AccountTemplate } from "@softilo/domain";

/**
 * Accounts the recruitment edition adds to the core UK chart. They are inserted into each tenant
 * lazily (the core chart is not changed). Roles are prefixed `rec_` so they never clash with core roles.
 */
export type RecAccountRole =
  | "rec_temp_fees" | "rec_perm_fees"
  | "rec_worker_pay" | "rec_holiday_pay" | "rec_oncosts"
  | "rec_pay_accrued" | "rec_holiday_accrued";

export interface RecAccountTemplate extends Omit<AccountTemplate, "role"> {
  role: RecAccountRole;
}

export const REC_CHART: RecAccountTemplate[] = [
  { code: "4010", name: "Temporary staffing fees", type: "income", role: "rec_temp_fees" },
  { code: "4020", name: "Permanent placement fees", type: "income", role: "rec_perm_fees" },
  { code: "5010", name: "Temporary worker pay", type: "expense", role: "rec_worker_pay" },
  { code: "5015", name: "Holiday pay – temporary workers", type: "expense", role: "rec_holiday_pay" },
  { code: "5020", name: "Employer on-costs – temporary workers", type: "expense", role: "rec_oncosts" },
  // Control accounts: only the timesheet (and, later, pay run) sub-ledger posts here.
  { code: "2120", name: "Temporary worker pay accrued", type: "liability", role: "rec_pay_accrued", control: true },
  { code: "2125", name: "Holiday pay accrued", type: "liability", role: "rec_holiday_accrued", control: true },
];

export type RecAccounts = Record<RecAccountRole, string>;

export function recAccounts(chart: RecAccountTemplate[] = REC_CHART): RecAccounts {
  return Object.fromEntries(chart.map((a) => [a.role, a.code])) as RecAccounts;
}
