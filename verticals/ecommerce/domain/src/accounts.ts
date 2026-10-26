import type { AccountTemplate } from "@softilo/domain";

/**
 * Accounts the e-commerce edition adds to the core UK chart. They are inserted per tenant
 * on first use, so the core chart template stays unchanged.
 */
export const ECOM_ACCOUNTS = {
  reserves: "1160",
  returnsWrittenOff: "5300",
  fees: "6100",
} as const;

export type EcomAccounts = { [K in keyof typeof ECOM_ACCOUNTS]: string };

export const ECOM_CHART: AccountTemplate[] = [
  { code: ECOM_ACCOUNTS.reserves, name: "Marketplace reserves held", type: "asset" },
  { code: ECOM_ACCOUNTS.returnsWrittenOff, name: "Returns written off", type: "expense" },
  { code: ECOM_ACCOUNTS.fees, name: "Marketplace and payment fees", type: "expense" },
];
