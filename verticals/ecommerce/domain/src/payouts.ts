import {
  cr, d, dr, finalise, round2, sum, vatCode as vatCodeDef, ZERO, type Dec, type JournalLine,
  type Posting, type RoleMap, type VatCode, type VatEntry,
} from "@softilo/domain";
import type { ChannelPayout, PayoutLineKind } from "./channels.js";
import type { EcomAccounts } from "./accounts.js";

/** VAT codes a channel's fees can carry. */
export type FeeVatCode = Extract<VatCode, "S20" | "RC20" | "EX" | "OS">;
export const FEE_VAT_CODES: FeeVatCode[] = ["S20", "RC20", "EX", "OS"];

export interface PayoutSplit {
  /** Gross sales the payout collects (orders settled). */
  sales: Dec;
  /** Refunds paid out of the payout, as a positive amount. */
  refunds: Dec;
  /** Fees as deducted from the payout, as a positive amount. */
  feesGross: Dec;
  feesNet: Dec;
  /** VAT on fees: charged by the channel (S20, reclaimable) or self-accounted (RC20). */
  feesVat: Dec;
  feeVatCode: FeeVatCode;
  /** Held back (negative) or released (positive) by the channel. */
  reserves: Dec;
  /** Anything else the channel added or took (chargebacks, corrections), signed. */
  adjustments: Dec;
  /** What the lines add up to. */
  computed: Dec;
  /** What the channel says reached the bank. */
  amount: Dec;
  difference: Dec;
  reconciled: boolean;
}

/**
 * Split a payout into sales, refunds, fees (with their VAT), reserves and adjustments,
 * and check the lines add up to the amount paid to the bank.
 *
 * Fee VAT:
 * - S20: the channel charges UK VAT (e.g. Amazon's UK seller fees); the fee deducted is VAT-inclusive.
 * - RC20: an overseas supplier (e.g. Shopify, from Ireland) charges no VAT; the brand self-accounts
 *   20% as both output and input VAT, so the fee deducted is the net amount.
 * - EX / OS: exempt (some payment processing) or outside the scope.
 * VAT is worked out on the payout's total fees, as it would be on the channel's fee invoice.
 */
export function splitPayout(p: ChannelPayout, feeVatCode: FeeVatCode): PayoutSplit {
  const by = (kind: PayoutLineKind) => sum(p.lines.filter((l) => l.kind === kind).map((l) => d(l.amount)));
  const sales = by("order");
  const refunds = by("refund").neg();
  const feesGross = by("fee").neg();
  const reserves = by("reserve");
  const adjustments = by("adjustment");
  const def = vatCodeDef(feeVatCode);
  const rate = d(def.rate);
  let feesVat: Dec;
  let feesNet: Dec;
  if (def.selfAccounted) {
    feesNet = feesGross;
    feesVat = round2(feesGross.times(rate));
  } else {
    feesVat = round2(feesGross.times(rate).dividedBy(rate.plus(1)));
    feesNet = feesGross.minus(feesVat);
  }
  const computed = sales.minus(refunds).minus(feesGross).plus(reserves).plus(adjustments);
  const amount = d(p.amount);
  const difference = amount.minus(computed);
  return {
    sales, refunds, feesGross, feesNet, feesVat, feeVatCode, reserves, adjustments,
    computed, amount, difference, reconciled: difference.isZero(),
  };
}

export class PayoutMismatchError extends Error {}

export interface PayoutClearingInput {
  date: string;
  reference: string;
  bankAccount: string;
  split: PayoutSplit;
  accounts: EcomAccounts;
  /** Where adjustments go until someone codes them (defaults to suspense). */
  adjustmentAccount?: string;
}

/**
 * The payout clearing journal:
 *   Dr Bank                         amount received
 *   Cr Trade debtors                sales settled (the channel's invoices)
 *   Dr Trade debtors                refunds settled (the credit notes)
 *   Dr Marketplace fees             fees net of VAT
 *   Dr VAT input (and Cr VAT output for reverse charge)
 *   Dr/Cr Marketplace reserves      held / released
 *   Dr/Cr Suspense                  adjustments to be coded
 * Refuses a payout that doesn't reconcile to the penny.
 */
export function postPayoutClearing(acc: RoleMap, input: PayoutClearingInput): Posting {
  const s = input.split;
  if (!s.reconciled) {
    throw new PayoutMismatchError(`Payout lines add up to ${s.computed.toFixed(2)} but ${s.amount.toFixed(2)} was paid (difference ${s.difference.toFixed(2)})`);
  }
  const def = vatCodeDef(s.feeVatCode);
  const lines: JournalLine[] = [
    dr(input.bankAccount, s.amount, "Payout received"),
    cr(acc.debtors, s.sales, "Sales settled"),
    dr(acc.debtors, s.refunds, "Refunds settled"),
    dr(input.accounts.fees, s.feesNet, "Channel fees"),
    dr(acc.vat_input, s.feesVat),
    dr(input.accounts.reserves, s.reserves.neg(), "Reserve held by channel"),
    dr(input.adjustmentAccount ?? acc.suspense, s.adjustments.neg(), "Channel adjustments"),
  ];
  if (def.selfAccounted) lines.push(cr(acc.vat_output, s.feesVat));
  const vat: VatEntry[] = s.feesGross.isZero() ? [] : [{ direction: "purchase", code: s.feeVatCode, net: s.feesNet, vat: s.feesVat }];
  return { journal: finalise({ date: input.date, memo: `Channel payout ${input.reference}`, lines }), vat };
}

/** Sum signed amounts for one order across a payout's lines (used to match payouts to invoices). */
export function amountsByOrder(p: ChannelPayout, kind: "order" | "refund"): Map<string, Dec> {
  const out = new Map<string, Dec>();
  for (const l of p.lines) {
    if (l.kind !== kind) continue;
    if (!l.orderRef) throw new Error(`A ${kind} line in payout ${p.externalId} has no order reference`);
    out.set(l.orderRef, (out.get(l.orderRef) ?? ZERO).plus(kind === "refund" ? d(l.amount).neg() : d(l.amount)));
  }
  return out;
}
