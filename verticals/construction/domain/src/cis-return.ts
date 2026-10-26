import { d, sum, toFixed, type DecInput } from "@softilo/domain";
import { cisPaymentShare, type CisBill, type CisStatus } from "./cis.js";
import type { TaxMonth } from "./dates.js";

/** A payment (or part of one) made against a CIS bill. */
export interface CisPayment {
  date: string;
  /** Orders payments made on the same day. */
  sequence: string;
  amount: DecInput;
}

export interface CisBillWithPayments extends CisBill {
  billId: string;
  billNumber: string;
  supplierRef: string;
  subcontractorId: string;
  payments: CisPayment[];
}

export interface Subcontractor {
  id: string;
  name: string;
  utr: string;
  status: CisStatus;
  /** HMRC verification number; must be shown when deducting at the unmatched (30%) rate. */
  verificationNumber: string | null;
}

export interface StatementLine {
  billNumber: string;
  supplierRef: string;
  paymentDate: string;
  paid: string;
  gross: string;
  materials: string;
  deduction: string;
}

/** One subcontractor's payment and deduction statement, which is also their row on the CIS300. */
export interface PaymentDeductionStatement {
  subcontractor: Subcontractor;
  /** Shown on the return only when the unmatched rate was used. */
  verificationNumber: string | null;
  lines: StatementLine[];
  /** Gross amount paid, excluding VAT. */
  grossPaid: string;
  costOfMaterials: string;
  amountLiable: string;
  amountDeducted: string;
  /** What the subcontractor actually received (including any VAT charged). */
  netPaid: string;
}

export interface Cis300Preview {
  month: TaxMonth;
  statements: PaymentDeductionStatement[];
  totals: { grossPaid: string; costOfMaterials: string; amountDeducted: string; subcontractors: number };
  /** True when no subcontractor was paid: a nil return (or an inactivity request) is due. */
  nil: boolean;
}

/**
 * Build the monthly CIS300 return and payment and deduction statements from the payments made
 * in a tax month. Each payment is turned into its share of the bill's CIS figures, in date order,
 * so part-paid bills are reported in the months they were actually paid.
 */
export function buildCis300(month: TaxMonth, subs: Subcontractor[], bills: CisBillWithPayments[]): Cis300Preview {
  const bySub = new Map<string, StatementLine[]>();
  for (const bill of bills) {
    const ordered = [...bill.payments].sort((a, b) => a.date.localeCompare(b.date) || a.sequence.localeCompare(b.sequence));
    let paid = d(0);
    for (const p of ordered) {
      const share = cisPaymentShare(bill, paid, p.amount);
      paid = paid.plus(p.amount);
      if (p.date < month.start || p.date > month.end) continue;
      const lines = bySub.get(bill.subcontractorId) ?? [];
      lines.push({
        billNumber: bill.billNumber, supplierRef: bill.supplierRef, paymentDate: p.date, paid: toFixed(p.amount),
        gross: toFixed(share.gross), materials: toFixed(share.materials), deduction: toFixed(share.deduction),
      });
      bySub.set(bill.subcontractorId, lines);
    }
  }
  const statements: PaymentDeductionStatement[] = [];
  for (const sub of [...subs].sort((a, b) => a.name.localeCompare(b.name))) {
    const lines = bySub.get(sub.id);
    if (!lines?.length) continue;
    const gross = sum(lines.map((l) => l.gross));
    const materials = sum(lines.map((l) => l.materials));
    statements.push({
      subcontractor: sub,
      verificationNumber: sub.status === "unmatched" ? sub.verificationNumber : null,
      lines,
      grossPaid: toFixed(gross),
      costOfMaterials: toFixed(materials),
      amountLiable: toFixed(gross.minus(materials)),
      amountDeducted: toFixed(sum(lines.map((l) => l.deduction))),
      netPaid: toFixed(sum(lines.map((l) => l.paid))),
    });
  }
  return {
    month,
    statements,
    totals: {
      grossPaid: toFixed(sum(statements.map((s) => s.grossPaid))),
      costOfMaterials: toFixed(sum(statements.map((s) => s.costOfMaterials))),
      amountDeducted: toFixed(sum(statements.map((s) => s.amountDeducted))),
      subcontractors: statements.length,
    },
    nil: statements.length === 0,
  };
}
