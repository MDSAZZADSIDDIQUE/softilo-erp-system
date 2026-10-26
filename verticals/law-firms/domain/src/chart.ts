import type { AccountType } from "@softilo/domain";

export type LawAccountRole = "client_bank" | "client_control" | "fees" | "disbursements";

/**
 * Accounts a law firm needs on top of the core UK chart. The client bank account is deliberately
 * not a core bank account, so core receipts and payments can never touch client money.
 */
export const LAW_CHART: { code: string; name: string; type: AccountType; role: LawAccountRole; control: boolean }[] = [
  { code: "1105", name: "Disbursements recoverable", type: "asset", role: "disbursements", control: false },
  { code: "1250", name: "Client bank account", type: "asset", role: "client_bank", control: true },
  { code: "2300", name: "Client money held", type: "liability", role: "client_control", control: true },
  { code: "4010", name: "Professional fees", type: "income", role: "fees", control: false },
];
