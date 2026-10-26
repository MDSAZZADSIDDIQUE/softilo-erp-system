/**
 * UK chart of accounts template (FRS 102 layout) seeded into every new tenant.
 * Accounts with a `role` are system accounts the posting engine relies on.
 * Control accounts accept postings only from their sub-ledgers.
 */
export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export type AccountRole =
  | "stock" | "debtors" | "bank" | "creditors" | "grni" | "landed_cost_clearing"
  | "vat_input" | "vat_output" | "vat_control" | "retained_earnings"
  | "sales" | "cogs" | "ppv" | "fx" | "suspense";

export interface AccountTemplate {
  code: string;
  name: string;
  type: AccountType;
  role?: AccountRole;
  control?: boolean;
}

export const UK_CHART: AccountTemplate[] = [
  { code: "0030", name: "Office equipment", type: "asset" },
  { code: "1001", name: "Stock", type: "asset", role: "stock", control: true },
  { code: "1100", name: "Trade debtors", type: "asset", role: "debtors", control: true },
  { code: "1103", name: "Prepayments", type: "asset" },
  { code: "1200", name: "Bank current account", type: "asset", role: "bank" },
  { code: "1210", name: "Bank deposit account", type: "asset" },
  { code: "2100", name: "Trade creditors", type: "liability", role: "creditors", control: true },
  { code: "2105", name: "Goods received not invoiced", type: "liability", role: "grni", control: true },
  { code: "2110", name: "Landed cost clearing", type: "liability", role: "landed_cost_clearing" },
  { code: "2109", name: "Accruals", type: "liability" },
  { code: "2200", name: "VAT on sales (output)", type: "liability", role: "vat_output", control: true },
  { code: "2201", name: "VAT on purchases (input)", type: "liability", role: "vat_input", control: true },
  { code: "2202", name: "VAT liability", type: "liability", role: "vat_control" },
  { code: "2210", name: "PAYE and NI", type: "liability" },
  { code: "3000", name: "Share capital", type: "equity" },
  { code: "3200", name: "Retained earnings", type: "equity", role: "retained_earnings" },
  { code: "4000", name: "Sales", type: "income", role: "sales" },
  { code: "4900", name: "Carriage income", type: "income" },
  { code: "5000", name: "Cost of sales", type: "expense", role: "cogs" },
  { code: "5100", name: "Purchase price variance", type: "expense", role: "ppv" },
  { code: "5200", name: "Carriage and freight", type: "expense" },
  { code: "7000", name: "Wages and salaries", type: "expense" },
  { code: "7100", name: "Rent and rates", type: "expense" },
  { code: "7200", name: "Utilities", type: "expense" },
  { code: "7500", name: "Office costs", type: "expense" },
  { code: "7600", name: "Professional fees", type: "expense" },
  { code: "7900", name: "Bank charges", type: "expense" },
  { code: "8000", name: "Foreign exchange gains and losses", type: "expense", role: "fx" },
  { code: "9999", name: "Suspense", type: "asset", role: "suspense" },
];

export type RoleMap = Record<AccountRole, string>;

/** Account codes for each system role, from a chart. */
export function roleMap(chart: AccountTemplate[] = UK_CHART): RoleMap {
  const map: Partial<RoleMap> = {};
  for (const a of chart) if (a.role) map[a.role] = a.code;
  return map as RoleMap;
}

/** Debit-normal accounts show a positive balance when debits exceed credits. */
export function isDebitNormal(type: AccountType): boolean {
  return type === "asset" || type === "expense";
}
