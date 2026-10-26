import {
  cr, d, dr, finalise, postSalesInvoice, round2, ZERO,
  type BillPosting, type Dec, type DecInput, type RoleMap, type VatCode,
} from "@softilo/domain";
import { addDays, maxDate } from "./dates.js";

/**
 * Interim applications for payment (JCT-style valuations).
 *
 * Each application values the work done to date (cumulative), holds back retention on it, and
 * asks for the difference between the net valuation and what was applied for before. Half the
 * retention is released at practical completion and the rest on the final account, after the
 * defects period, simply by applying a lower retention rate to the cumulative value.
 */
export type ApplicationStage = "interim" | "practical_completion" | "final";

export function retentionRateFor(contractRate: DecInput, stage: ApplicationStage): Dec {
  const r = d(contractRate);
  if (r.isNegative() || r.greaterThan("0.2")) throw new Error("Retention rate must be between 0% and 20%");
  return stage === "interim" ? r : stage === "practical_completion" ? r.dividedBy(2) : ZERO;
}

export interface Previous {
  grossToDate: DecInput;
  retentionToDate: DecInput;
  netToDate: DecInput;
}

export const NO_PREVIOUS: Previous = { grossToDate: 0, retentionToDate: 0, netToDate: 0 };

export interface Valuation {
  grossToDate: Dec;
  retentionRate: Dec;
  retentionToDate: Dec;
  netToDate: Dec;
  /** Value of work in this period (revenue to recognise). */
  thisPeriodGross: Dec;
  /** Change in retention held: positive = more held back, negative = released. */
  retentionMovement: Dec;
  /** Net amount applied for now (VAT is charged on this). */
  amountDue: Dec;
}

export function valueApplication(i: { grossToDate: DecInput; contractRetentionRate: DecInput; stage: ApplicationStage; previous?: Previous }): Valuation {
  const prev = i.previous ?? NO_PREVIOUS;
  const gross = round2(i.grossToDate);
  if (gross.isNegative()) throw new Error("Gross valuation cannot be negative");
  const rate = retentionRateFor(i.contractRetentionRate, i.stage);
  const retention = round2(gross.times(rate));
  const net = gross.minus(retention);
  const amountDue = net.minus(prev.netToDate);
  if (!amountDue.isPositive()) {
    throw new Error("Nothing more is due: the net valuation is not above what has already been applied for");
  }
  return {
    grossToDate: gross,
    retentionRate: rate,
    retentionToDate: retention,
    netToDate: net,
    thisPeriodGross: gross.minus(prev.grossToDate),
    retentionMovement: retention.minus(prev.retentionToDate),
    amountDue,
  };
}

/**
 * Post an application as a sales invoice for the amount due, plus the movement in retention:
 *   Dr debtors (amount due + VAT charged), Dr retentions receivable (retention held this period)
 *   Cr sales (value of work this period), Cr VAT output (unless reverse charge)
 * VAT on retention is charged when it is released and invoiced, which is its tax point.
 */
export function postApplication(acc: RoleMap, retentionAccount: string, a: {
  date: string; reference: string; valuation: Valuation; vatCode: VatCode; salesAccount?: string;
}): BillPosting {
  const base = postSalesInvoice(acc, {
    date: a.date,
    reference: a.reference,
    rate: 1,
    lines: [{ net: a.valuation.amountDue, vatCode: a.vatCode, account: a.salesAccount, description: `Application ${a.reference}` }],
  });
  const salesAccount = a.salesAccount ?? acc.sales;
  const journal = finalise({
    ...base.journal,
    memo: `Application for payment ${a.reference}`,
    lines: [
      ...base.journal.lines,
      dr(retentionAccount, a.valuation.retentionMovement, "Retention"),
      cr(salesAccount, a.valuation.retentionMovement, `Application ${a.reference}`),
    ],
  });
  return { ...base, journal };
}

/**
 * Payment timetable under the Housing Grants, Construction and Regeneration Act 1996 (as amended
 * in 2011). Contracts set their own periods; where they do not, the Scheme for Construction
 * Contracts fills the gap: due 7 days after the end of the valuation period (or the claim, if
 * later), final date for payment 17 days after the due date, payer's payment notice within 5
 * days of the due date, and pay-less notice no later than 7 days before the final date.
 */
export interface PaymentTerms {
  dueDays: number;
  finalDays: number;
  paymentNoticeDays: number;
  payLessDays: number;
}

export const SCHEME_TERMS: PaymentTerms = { dueDays: 7, finalDays: 17, paymentNoticeDays: 5, payLessDays: 7 };

export interface PaymentTimetable {
  dueDate: string;
  finalDate: string;
  paymentNoticeBy: string;
  payLessNoticeBy: string;
}

export function paymentTimetable(periodEnd: string, applicationDate: string, terms: PaymentTerms = SCHEME_TERMS): PaymentTimetable {
  const dueDate = maxDate(addDays(periodEnd, terms.dueDays), applicationDate);
  const finalDate = addDays(dueDate, terms.finalDays);
  return {
    dueDate,
    finalDate,
    paymentNoticeBy: addDays(dueDate, terms.paymentNoticeDays),
    payLessNoticeBy: addDays(finalDate, -terms.payLessDays),
  };
}
