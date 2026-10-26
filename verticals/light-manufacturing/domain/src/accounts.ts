import type { AccountTemplate } from "@softilo/domain";

/**
 * Accounts the manufacturing edition adds to a tenant's chart. They are inserted the first time
 * the tenant uses manufacturing, so the core chart template is unchanged.
 * Finished goods and raw materials share the core Stock control account, which keeps the core
 * stock-vs-ledger integrity check valid; WIP is reconciled to works-order transactions instead.
 */
export type MfgRole = "wip" | "scrap" | "production_variance" | "labour_absorbed" | "overhead_absorbed";

export const MFG_ACCOUNTS: (Omit<AccountTemplate, "role"> & { role: MfgRole })[] = [
  { code: "1002", name: "Work in progress", type: "asset", role: "wip", control: true },
  { code: "5300", name: "Production scrap", type: "expense", role: "scrap" },
  { code: "5310", name: "Production variances", type: "expense", role: "production_variance" },
  // Credit-balance contra accounts: actual wages and overheads are posted as usual, so the P&L
  // shows the under- or over-absorption next to them.
  { code: "5400", name: "Labour absorbed into production", type: "expense", role: "labour_absorbed" },
  { code: "5410", name: "Overheads absorbed into production", type: "expense", role: "overhead_absorbed" },
];

export type MfgRoleMap = Record<MfgRole, string>;

export function mfgRoleMap(chart = MFG_ACCOUNTS): MfgRoleMap {
  return Object.fromEntries(chart.map((a) => [a.role, a.code])) as MfgRoleMap;
}
