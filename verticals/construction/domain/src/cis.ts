import {
  cr, d, Dec, dr, finalise, postSupplierBill, round2, sum, ZERO,
  type BillPosting, type DecInput, type RoleMap, type VatCode,
} from "@softilo/domain";

/**
 * Construction Industry Scheme (CIS), contractor side.
 *
 * A contractor verifies each subcontractor with HMRC, which says how much to deduct:
 * nothing for gross payment status, 20% for registered (net) subcontractors, and 30% when
 * HMRC cannot match the subcontractor. The deduction is taken from the payment excluding
 * VAT and excluding what the subcontractor spent on materials, plant hire, consumables and
 * fuel (other than for travel): in practice, from the labour element.
 */
export type CisStatus = "gross" | "net" | "unmatched";

export const CIS_RATES: Record<CisStatus, string> = { gross: "0", net: "0.20", unmatched: "0.30" };

/**
 * How a job cost line is treated. Only `labour` is liable to a CIS deduction; materials,
 * plant hire and other direct costs the subcontractor bought are excluded.
 */
export type CostCategory = "labour" | "materials" | "plant" | "other";

export const COST_CATEGORIES: CostCategory[] = ["labour", "materials", "plant", "other"];

export function isCisLiable(category: CostCategory): boolean {
  return category === "labour";
}

/**
 * The deduction on the liable amount, rounded down to the penny so a subcontractor is never
 * over-deducted. (HMRC's guidance does not state a rounding rule; this is the conservative choice.)
 */
export function cisDeduction(liable: DecInput, status: CisStatus): Dec {
  const v = d(liable).times(CIS_RATES[status]);
  return v.isNegative() ? ZERO : v.toDecimalPlaces(2, Dec.ROUND_DOWN);
}

export interface JobBillLine {
  category: CostCategory;
  net: DecInput;
  vatCode: VatCode;
  /** Job cost account the line is charged to. */
  account: string;
  description?: string;
}

export interface JobBillInput {
  date: string;
  reference: string;
  /** Set for a verified CIS subcontractor; omit for a merchant or other non-CIS supplier. */
  cisStatus?: CisStatus;
  lines: JobBillLine[];
}

export interface CisFigures {
  /** Payment excluding VAT (labour plus materials), as reported on the CIS300. */
  gross: Dec;
  /** Materials, plant and other non-labour costs within `gross`. */
  materials: Dec;
  /** The part of `gross` liable to deduction. */
  liable: Dec;
  rate: string;
  deduction: Dec;
}

export interface JobBillPosting extends BillPosting {
  /** CIS figures, or null when the supplier is not a CIS subcontractor. */
  cis: CisFigures | null;
}

/**
 * A job bill from a supplier or subcontractor. The core supplier-bill rule posts costs, VAT
 * (including the domestic reverse charge) and the amount owed; for a CIS subcontractor the
 * deduction is then moved from what the subcontractor is owed to the CIS liability account,
 * which is paid to HMRC with the monthly return.
 *
 *   Dr job costs, Dr VAT input [, Cr VAT output if reverse charge]
 *   Cr creditors (owed to the subcontractor, after deduction)
 *   Cr CIS deductions payable
 */
export function postJobBill(acc: RoleMap, cisLiabilityAccount: string, b: JobBillInput): JobBillPosting {
  for (const l of b.lines) if (d(l.net).isNegative()) throw new Error("Job bill lines cannot be negative");
  const base = postSupplierBill(acc, {
    date: b.date,
    reference: b.reference,
    rate: 1,
    lines: b.lines.map((l) => ({ kind: "account" as const, net: l.net, vatCode: l.vatCode, account: l.account, description: l.description })),
  });
  if (!b.cisStatus) return { ...base, cis: null };

  const gross = round2(sum(b.lines.map((l) => round2(l.net))));
  const liable = round2(sum(b.lines.filter((l) => isCisLiable(l.category)).map((l) => round2(l.net))));
  const deduction = cisDeduction(liable, b.cisStatus);
  const journal = finalise({
    ...base.journal,
    memo: `Subcontractor bill ${b.reference}`,
    lines: [...base.journal.lines, dr(acc.creditors, deduction), cr(cisLiabilityAccount, deduction)],
  });
  return {
    journal,
    vat: base.vat,
    total: base.total.minus(deduction),
    totalGbp: base.totalGbp.minus(deduction),
    cis: { gross, materials: gross.minus(liable), liable, rate: CIS_RATES[b.cisStatus], deduction },
  };
}

/** The CIS figures of one bill, as stored, with what the subcontractor is owed after deduction. */
export interface CisBill {
  /** Amount payable to the subcontractor (gross + VAT charged − deduction). */
  payable: DecInput;
  gross: DecInput;
  materials: DecInput;
  deduction: DecInput;
}

export interface CisShare {
  gross: Dec;
  materials: Dec;
  deduction: Dec;
}

/**
 * The part of a bill's CIS figures that a payment represents. CIS is reported when the
 * subcontractor is paid, so a bill paid in instalments is reported pro rata across tax months.
 * Shares are worked out cumulatively (figure × paid to date ÷ payable), so the instalments of a
 * fully paid bill always add up to the bill's figures to the penny.
 */
export function cisPaymentShare(bill: CisBill, paidBefore: DecInput, paidNow: DecInput): CisShare {
  const payable = d(bill.payable);
  if (!payable.isPositive()) throw new Error("A CIS bill must have something payable");
  const before = d(paidBefore);
  const after = before.plus(paidNow);
  if (after.greaterThan(payable)) throw new Error("Payments exceed the amount payable on the bill");
  const cumulative = (figure: DecInput, paid: Dec) => round2(d(figure).times(paid).dividedBy(payable));
  const share = (figure: DecInput) => cumulative(figure, after).minus(cumulative(figure, before));
  return { gross: share(bill.gross), materials: share(bill.materials), deduction: share(bill.deduction) };
}
